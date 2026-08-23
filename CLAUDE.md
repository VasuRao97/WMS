# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

WMS MVP — a modular-monolith Warehouse Management System, built toward an eventual
multi-company SaaS product for real warehouse operations (with SAP/ERP integration and
handheld-device support intended from the start, not retrofitted). Priority order:
Usability → Operational Correctness → Data Integrity → Scalability → Advanced Features.
No microservices/Kubernetes — modular monolith is a deliberate, non-negotiable stance.

Stack: NestJS (TypeScript) + Prisma + PostgreSQL backend, React 19 + Vite (TypeScript)
frontend, no shared package/monorepo tooling — `backend/` and `frontend/` are two independent
npm projects. Repo: https://github.com/VasuRao97/WMS.git

**Prisma is pinned to v6 — do not upgrade to v7.** v7 changed the datasource config
(`url = env("DATABASE_URL")`) in a way that breaks this project's setup.

## Commands

Run from `backend/` or `frontend/` respectively — there is no root `package.json`.

### Backend (`backend/`)
```bash
npm run start:dev       # watch mode, http://localhost:3000
npm run build            # nest build
npm run lint              # eslint --fix
npm run format             # prettier --write src/**/*.ts test/**/*.ts
npm run test               # jest unit tests
npm run test -- warehouses.service   # run a single test file/suite by name pattern
npm run test:e2e           # jest e2e (test/jest-e2e.json)
npx prisma migrate dev --name <name>   # create + apply a migration after editing schema.prisma
npx prisma generate         # regenerate the Prisma client after schema changes
npx prisma studio            # inspect DB data
```

### Frontend (`frontend/`)
```bash
npm run dev       # vite dev server
npm run build      # tsc -b && vite build
npm run lint         # eslint .
```

### Infra
```bash
docker compose up -d   # starts Postgres only, at localhost:5432 (user/db `wms`, see docker-compose.yml)
```
`backend/.env` needs `DATABASE_URL` (points at the compose Postgres) and `JWT_SECRET`. No
backend/frontend services are in `docker-compose.yml` — run both with `npm run start:dev`/`npm run dev`.

## Architecture

### The inventory ledger is append-only — this is the core invariant
`stock_movements` (Prisma model `StockMovement`) is the single source of truth for stock. **No
code path ever runs `UPDATE` on a stock quantity.** Every receipt, putaway, pick, dispatch,
return, and manual adjustment inserts a new signed-quantity row (`MovementType`: RECEIPT,
PUTAWAY_OUT, PUTAWAY_IN, PICK, DISPATCH, RETURN_IN, ADJUSTMENT). Current on-hand stock at any
location is always derived:
```sql
SELECT sku_id, location_id, SUM(quantity) AS on_hand
FROM stock_movements GROUP BY sku_id, location_id;
```
Any new feature that touches stock must add movement rows, not mutate a quantity column.

### Module build order (see `backend/prisma/schema.prisma` for the full data model)
Master Data (warehouses/locations/SKUs/users) → Inbound (receipts) → Putaway → Inventory
(ledger + live views) → Outbound (orders/allocation) → Picking → Dispatch → Returns →
Analytics (built last, on top of everything). Only Master Data (warehouses, SKUs, customers)
and Auth are implemented in `backend/src` so far; the rest of the schema exists in
`schema.prisma` ahead of the corresponding Nest modules being built.

### Multi-tenancy model
`Company` is the tenant root; almost every model hangs off `companyId` (directly or via a
relation), proven with two real test companies confirming zero cross-tenant data leakage.
Codes are **unique per company, never globally** — `Sku.code`, `Warehouse.code`,
`Customer.code` all use `@@unique([companyId, code])`, so two different companies can both use
`"WH1"`. Don't add a bare global `@unique` on a code-like field.

`User.role` is one of `SUPER_ADMIN | COMPANY_ADMIN | WAREHOUSE_MANAGER |
WAREHOUSE_SUPERVISOR | OPERATOR` (`SUPER_ADMIN` is platform-level, no `companyId`, sees every
company — but there is no controlled way to create one yet; it needs a setup script, deliberately
not exposed via public `/auth/register`). Tenant scoping is enforced **in each service method**,
not by a global Prisma middleware: the convention (see `skus.service.ts`) is a
`companyFilter(user)` helper returning `{}` for `SUPER_ADMIN` and `{ companyId: user.companyId }`
otherwise, plus an `assertSkuAccess`-style per-record ownership check before mutating a single
record. Follow this pattern for any new service rather than trusting the client-supplied id alone.

`RolesGuard` + `@Roles()` (`backend/src/auth/roles.guard.ts`, `roles.decorator.ts`) implement
role-based checks but are **not currently wired into any controller** — only `JwtAuthGuard` is
applied (`@UseGuards(JwtAuthGuard)`). Right now any logged-in user of any role can do anything a
`COMPANY_ADMIN` can; authorization today is company-scoping in services, not role checks. A
`User` ↔ `Warehouse` many-to-many (`assignedWarehouses`) exists in the schema for future
per-warehouse restriction but is likewise unenforced. If you add role or warehouse enforcement,
apply `RolesGuard` alongside `JwtAuthGuard` and add `@Roles(...)` on the handler.

### Field modeling: core vs. non-core
A field stays flat on the main table only if a record can have exactly *one* of it. Anything a
record could plausibly have more than one of (barcodes, storage units, customer ship-to
addresses) becomes a separate linked child table instead (`SkuBarcode`, `SkuStorageUnit`,
`CustomerShipTo`). Apply this same test when adding fields to any master-data model.

### Validation: one function, two callers
Per-field, human-readable validation lives in the service layer (not just DB constraints), and
the **same** validation function backs both the manual create endpoint and the bulk Excel import
for a given entity (e.g. `SkusService.validateSkuData`) so the two paths can't drift apart. Keep
new entities' validation this way rather than duplicating rules between create and import.

### ERP integration hook (not yet wired)
`erpCode` fields exist on `Sku` and `Warehouse` (and should be added to `Customer` if it grows
one) purely as a landing spot for a future SAP/ERP master-data sync — there is no real
integration behind them yet.

### Backend module shape
Each feature is a self-contained Nest module (`warehouses/`, `skus/`, `customers/`, `auth/`):
`*.module.ts` declares its own `PrismaService` as a provider (there is no shared/global Prisma
module) alongside its controller/service. Controllers use `@CurrentUser()`
(`auth/current-user.decorator.ts`, reads `request.user` set by `JwtStrategy`) to get the
authenticated `{ userId, email, role, companyId }`, and depend on `JwtAuthGuard` for auth.

There is **no DTO/class-validator layer** — request bodies are typed `any` and validated by hand
in the service (see `SkusService.validateSkuData`, which returns a string[] of error messages
thrown via `BadRequestException`). Match this style for new endpoints rather than introducing
`class-validator` DTOs unless asked to.

`SkusController` shows the established pattern for bulk data ops: `xlsx` for
import (`sheet_to_json` → per-row validation, dedup within the file, dedup against the DB,
row-by-row success/error results) and export (`json_to_sheet` → buffer streamed via `Response`).
Reuse this shape for other modules needing Excel import/export.

### Every master-data entity gets a "Delete All" — build it in from day one
Warehouses, SKUs, and Customers all have a `DELETE /<resource>/all` endpoint (`removeAll` in the
service) plus a "Delete All" button in the list-page UI, wired up from the start rather than
added later — this is a deliberate standing convention, add it when scaffolding any new
master-data module, not as an afterthought. Pattern: scope to `companyFilter(user)`, then for
each record count linked child/transaction records via a Prisma `_count.select` across every
relation that would otherwise block a raw delete (see `WarehousesService.removeAll` — checks
`assignedUsers`, `shipToAssignments`, `locations`, `inboundReceipts`, `outboundOrders`,
`stockMovements`), skip (and report as "blocked") any record with links, bulk-delete the rest.
Entities with only cascade-safe children and no real downstream FK (e.g. `Customer` → only
`CustomerShipTo`) skip the blocking check and just delete children-then-parents in a
`$transaction`, matching their single-record `remove()`. **Route order matters**: `@Delete('all')`
must be declared before `@Delete(':id')` in the controller, or Nest matches `all` as an `:id`
param and the literal route never fires.

**Never smoke-test a `DELETE .../all` endpoint against real/seed data, even to verify a fix** —
create disposable throwaway records, exercise the endpoint against those, and clean up
afterward. Also let `nest start --watch` finish restarting (watch the log for a stable "Nest
application successfully started" line with no further restarts) before firing a destructive
request — mid-restart requests have run against a stale in-memory build of the service and
bypassed logic that was actually correct in the saved source. This wiped a real test company's
warehouses and a customer during development (2026-08-23); see git history / conversation if you
need the details. This applies doubly once real per-warehouse Inventory/Location data exists.

### Frontend
No router — `App.tsx` is a single component with local `tab` state switching between page
components (`WarehousesPage` inline in `App.tsx`, `SkusPage.tsx`, `CustomersPage.tsx`,
`LoginPage.tsx`). No API client/fetch wrapper — every page repeats the same pattern: a bare
`fetch('http://localhost:3000/<resource>', { headers: authHeaders() })` (backend base URL is
hardcoded, not env-driven), a `authHeaders()` closure reading `localStorage.getItem('token')`,
and a 401 handler that does `localStorage.clear(); window.location.reload()`. Auth state
(`token`, `user` JSON) lives in `localStorage`, set by `LoginPage` on successful login/register.
Follow the existing per-page fetch pattern for new pages rather than introducing a shared client
unless asked to.

No CSS framework/component library is installed despite being mentioned in `README.md`
("Getting started") — styling today is inline `style={{...}}` objects. Column show/hide on
list tables is deliberately deferred until more list pages exist, so it can be built once as a
reusable pattern rather than per-page.

## Status: what's built vs. what's next

Fully built, tested, and committed: Auth + multi-tenancy (JWT, `JwtAuthGuard`, tenant isolation
proven), Warehouses (create/list, a "Customers per Warehouse" rollup table with Local/Upcountry
split, Delete All), SKU Master (full CRUD incl. deactivate/reactivate/delete, bulk Excel
import/export with per-row errors, live summary analytics, Delete All), Customer Master (full
CRUD incl. multi ship-to per customer with per-ship-to GSTIN and a Local/Upcountry delivery-zone
tag for dispatch planning, bulk Excel import using a repeated-Bill-To-ID-per-row grouping
pattern, Delete All).

Explicitly deferred (don't assume these exist): `SUPER_ADMIN` account creation, role/`@Roles()`
enforcement, per-warehouse access enforcement, company-admin user invite flow, `SkuRelationship`
(kits/combos — schema exists, no logic), Inventory Control Policy master (min/max, reorder
point, FIFO/FEFO/LIFO), Opening Balance load, dispatch-proximity distance calculation (lat/long
fields exist, no algorithm), real SAP/ERP integration, and — per the module build order above —
everything from **Locations/Bins onward** (next on the roadmap), Inbound, Putaway, Inventory,
Outbound, Picking, Dispatch, Analytics. Cloud/production deployment hasn't happened; this is
local Docker Compose (Postgres) only.

## Testing notes
API testing is done with Thunder Client, but its free tier can't send file uploads — so Excel
import features must be exercised through the actual frontend, not Thunder Client.

## Windows/environment gotchas
- `prisma generate` file-lock errors: close every running terminal (`start:dev`, `prisma
  studio`, etc.), check Task Manager for leftover `node.exe`, delete `node_modules\.prisma`,
  then regenerate.
- `.env` encoding issues have come from PowerShell's `>` redirect and Notepad — edit `.env`
  directly in VS Code instead.
- Copy-pasted blocks (especially into `schema.prisma`) can silently merge two fields onto one
  line, producing confusing "not a valid field" errors; if a paste keeps failing, hand-type it
  and verify against the file on disk with `Select-String -Path <file> -Pattern "<term>"` rather
  than trusting the editor's display.
- Before chasing a repeat error, confirm the file actually saved (unsaved-changes dot on the VS
  Code tab) — some "same error keeps happening" loops have just been an unsaved file.

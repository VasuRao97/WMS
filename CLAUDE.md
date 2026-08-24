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
not by a global Prisma middleware: the convention is `companyFilter(user)` from
`backend/src/common/tenant.util.ts` — returns `{}` for `SUPER_ADMIN` and `{ companyId:
user.companyId }` otherwise — imported by every service's `findAll`/`removeAll`/summary queries,
plus an `assertSkuAccess`-style per-record ownership check before mutating a single record.
Follow this pattern for any new service rather than trusting the client-supplied id alone —
**and remember any lookup keyed by a value that isn't itself `companyId`-scoped (e.g. SKU
barcodes) still needs an explicit tenant filter joined through its parent record**; this was
missed once (`SkuBarcode` has no `companyId` column, so its uniqueness check needs `sku: {
companyId: user.companyId }` in the `where`, not just `barcode: { in: [...] }`).

`RolesGuard` + `@Roles()` (`backend/src/auth/roles.guard.ts`, `roles.decorator.ts`) implement
role-based checks — `RolesGuard` special-cases `SUPER_ADMIN` to always pass, otherwise requires
`user.role` to be one of the names given to `@Roles(...)`; a handler with no `@Roles()` is
unaffected (open to any authenticated role, same as before). **First and so far only use**:
every destructive delete endpoint (`DELETE /warehouses/all`, `DELETE|DELETE all /skus`,
`DELETE|DELETE all /customers`) is `@Roles('COMPANY_ADMIN')`, restricting deletion to Company
Admin (+ Super Admin) — a `WAREHOUSE_MANAGER` cannot delete anything, by design (2026-08-24); a
request/approval flow letting a Manager ask their Admin to delete on their behalf is a deliberate
follow-up, not built yet. Every other endpoint across every controller is still open to any
authenticated role — right now a `WAREHOUSE_MANAGER`/`WAREHOUSE_SUPERVISOR`/`OPERATOR` can create/
edit/view anything a `COMPANY_ADMIN` can except delete; authorization elsewhere is still
company-scoping in services, not role checks. A `User` ↔ `Warehouse` many-to-many
(`assignedWarehouses`) exists in the schema for future per-warehouse restriction but is likewise
unenforced. Follow the same pattern (`@UseGuards(JwtAuthGuard, RolesGuard)` at the controller
level, `@Roles('COMPANY_ADMIN')` — or whichever roles — on the specific handler) for any further
role enforcement.

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
`erpCode` fields exist on `Sku`, `Warehouse`, and `Customer` purely as a landing spot for a
future SAP/ERP master-data sync — there is no real integration behind them yet.

### Backend module shape
Each feature is a self-contained Nest module (`warehouses/`, `skus/`, `customers/`, `auth/`):
`*.module.ts` declares its own `PrismaService` as a provider (there is no shared/global Prisma
module) alongside its controller/service. Controllers use `@CurrentUser()`
(`auth/current-user.decorator.ts`, reads `request.user` set by `JwtStrategy`) to get the
authenticated `{ userId, email, role, companyId }`, and depend on `JwtAuthGuard` for auth.

`backend/src/common/` holds cross-module utilities every service/controller should import rather
than re-implement: `tenant.util.ts` (`companyFilter`), `normalize.util.ts` (`normalizeCode`, for
free-text classification fields — see below), `validation.util.ts` (`CODE_REGEX`, `PINCODE_REGEX`
— every master-data code field follows the same alphanumeric/hyphen/30-char rule), and
`xlsx-parse.util.ts` (`toBool`, `toNumberOrUndefined`, for reading Excel cell values in import
controllers). These didn't always exist — SKU/Warehouse/Customer each grew their own copies
first and got consolidated in a cleanup pass (2026-08-23); don't let a fourth master-data module
reintroduce a fifth copy.

There is **no DTO/class-validator layer** — request bodies are typed `any` and validated by hand
in the service (see `SkusService.validateSkuData`, which returns a string[] of error messages
thrown via `BadRequestException`). Match this style for new endpoints rather than introducing
`class-validator` DTOs unless asked to.

`SkusController` shows the established pattern for bulk data ops: `xlsx` for
import (`sheet_to_json` → per-row validation, dedup within the file, dedup against the DB,
row-by-row success/error results) and export (`json_to_sheet` → buffer streamed via `Response`).
Reuse this shape for other modules needing Excel import/export.

**Read import sheets by name, not position.** SKU/Customer read `workbook.SheetNames[0]`
(historical, works because their templates only ever had one meaningful sheet). Warehouse
Master's template ships with "How To Use" and "Legend & Rules" tabs alongside the data —
`warehouses.controller.ts` reads `workbook.Sheets['Warehouse Import']` explicitly. Do this for
any new import too; reading by position is a real footgun (bit a template earlier in this
project's history — a sheet got reordered and the importer silently read the wrong tab).

**Free-text classification values get normalized to `SCREAMING_SNAKE_CASE`, not stored as an
enum.** See `common/normalize.util.ts`'s `normalizeCode()` — `"Ground/Floor"` → `GROUND_FLOOR`,
`"Drive-in"` → `DRIVE_IN`, `"Regional DC"` → `REGIONAL_DC` (strip whitespace/`/`/`-`, uppercase).
This lets both the manual-create form (which submits the canonical value directly) and the Excel
import (which submits whatever human-readable label was typed in a cell) validate against the
same restricted list without a lookup table. Reuse this helper — don't hand-roll a new
label→code mapping per field (this was missed once for `CustomerShipTo.deliveryZone`, which had
two inconsistent hand-rolled normalizations — one trimmed, one didn't — that disagreed on the
same input).

### Platform-managed reference data: `ProductCategory` and `CategoryPackSpec`
Some classification fields are curated centrally rather than typed per-company — `ProductCategory`
(`id`, `name`, unique) is the first of these: seeded directly via `prisma/seed.ts` (`npx prisma db
seed`, safe to re-run — upsert by name), with **no client-facing create/edit UI**, just a
read-only `GET /product-categories` (`product-categories/` module) that other pages' dropdowns
pull from. `Sku.category` and `WarehouseStorageType.category` are both real FKs into it (resolved
case-insensitively from a plain name string — same shape as `CustomersService.resolveShipTos`
resolving a `warehouseCode` — defaulting to `"Uncategorized"` when blank), not free text; this
keeps a SKU's category and a warehouse's storage-type breakdown's category guaranteed to be the
same list, so they can be joined without a translation layer. `CategoryPackSpec`
(`categoryId` + `unitType` → `lengthCm`/`widthCm`/`heightCm`/`weightKg`) is the same pattern one
level further: `Sku.primaryStorageUnit` names which of a SKU's own `SkuStorageUnit` rows
(EACH/INNER/CASE/PALLET) is its primary putaway/pick unit, and the actual packaging dimensions for
"a Car Tyres CASE" live once in `CategoryPackSpec`, not duplicated per SKU — correcting a case size
later means editing one row, not every SKU in that category. Follow this same repository shape
(central table, no self-serve UI, name-based resolution defaulting sensibly) for any future field
that's naturally shared across many records of a classification rather than genuinely per-record.
`WarehouseStorageType` also carries its own `lengthM`/`widthM`/`heightM` — that's a *different*
thing (a warehouse's own bin/pallet-position size for that storage type × category, for space
planning), not to be confused with `CategoryPackSpec`'s per-item packaging dimensions.

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
No router — `App.tsx` is a thin shell with local `tab` state switching between page components
(`WarehousesPage.tsx`, `SkusPage.tsx`, `CustomersPage.tsx`, `LoginPage.tsx` — one file each). No
API client/fetch wrapper — every page repeats the same pattern: a bare
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
proven), **Warehouse Master** — doubles as a network-node master, not just storage warehouses:
`nodeType` (Factory/Distributor/Regional DC/National DC/CNF/Cross-dock, one `Warehouse` table for
all of them, operational fields optional on every row regardless of type), city/pincode/lat-long,
GSTIN, working days/hours, primary contact name/phone, 3PL name, docks, area sq ft, a repeatable
`WarehouseStorageType` breakdown (storage type × `ProductCategory` × pallet positions × optional
`lengthM`/`widthM`/`heightM`, unique per storage-type+category pair so the same category can span
multiple storage types, "Mix" as a value in the same list with a same-warehouse exclusivity
guardrail against mixing it with specific types), a repeatable `WarehouseDispatchFlow` capability
list (Full Pallet/Case Pick/Broken Case, no paired quantity), bulk Excel import (single-sheet,
repeated-Location-Code grouping, name auto-derived from City+Type since the template has no name
column), deactivate/reactivate, a "Customers per Warehouse" rollup with Local/Upcountry split,
Delete All. SKU Master (full CRUD incl. deactivate/reactivate/delete, `category` as a
`ProductCategory` FK rather than free text, `primaryStorageUnit` naming which `SkuStorageUnit` is
primary, bulk Excel import/export with per-row errors, live summary analytics, Delete All).
Customer Master (full CRUD incl. multi ship-to per customer with per-ship-to GSTIN and a
Local/Upcountry delivery-zone tag for dispatch planning, bulk Excel import using a
repeated-Bill-To-ID-per-row grouping pattern, Delete All). See "Platform-managed reference data"
above for `ProductCategory`/`CategoryPackSpec`, the repository pattern behind several of these.

All three master-data pages (`WarehousesPage.tsx`, `SkusPage.tsx`, `CustomersPage.tsx`) now have
a manual "Add ___" form, collapsed behind a `showForm` toggle (`▸ Add ___ manually` /
`▾ Hide manual entry`, closed by default) — bulk Excel import is the primary path for these
master lists at real scale, manual entry is a secondary affordance. Apply the same toggle
pattern to any new master-data page's manual-create form.

Of the five Master Data entities named in the module build order above (warehouses/locations/
SKUs/customers/users), two are still genuinely pending: **Locations/Bins** (schema exists, no
service/controller/frontend — real bin generation needs its own design pass first: numbering
scheme, aisle/rack/level structure, how pallet counts get carved out by function/zone) and
**Users** (no page/invite flow exists beyond the one `COMPANY_ADMIN` created at company
registration — see `SUPER_ADMIN`/role items below).

Also explicitly deferred (don't assume these exist): `SUPER_ADMIN` account creation, role/
`@Roles()` enforcement, per-warehouse access enforcement, company-admin user invite flow,
`SkuRelationship` (kits/combos — schema exists, no logic), `CategoryPackSpec` has no real rows yet
(seeded empty, same as `ProductCategory` was at first), Inventory Control Policy master (min/max,
reorder point, FIFO/FEFO/LIFO), Opening Balance load, dispatch-proximity distance calculation
(lat/long fields exist, no algorithm), a dispatch cutoff-time/policy concept (deliberately not
added alongside Warehouse's working-hours fields — it's a policy, not a static fact, and belongs
to a future Dispatch Policy stage once Outbound/Dispatch exist to enforce it), real SAP/ERP
integration, and — per the module build order above — Inbound, Putaway, Inventory, Outbound,
Picking, Dispatch, Analytics. Cloud/production deployment hasn't happened; this is local Docker
Compose (Postgres) only.

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
- If a dev-server preview tool's log stream shows compilation finishing ("Found 0 errors...")
  but never shows the Nest bootstrap lines that normally follow immediately after, don't assume
  the process crashed — the log stream can just stop flushing. Confirm with a direct request
  (`curl http://localhost:3000/`) before concluding the server is down; a real failure will
  refuse the connection, a log-streaming hiccup will respond normally.
- `nest start --watch` can crash outright on its own restart logic — on a file change it shells
  out to `taskkill` to kill the previous child process, and if that process already exited (a race,
  not an actual problem) the `taskkill` throws and takes the whole watcher down with it
  (`ERROR: The process "<pid>" not found` followed by an uncaught exception, exit code 1). The
  already-running server process is unaffected and keeps serving on its last successful build —
  confirm with `curl`/`netstat` before assuming it's down — but it won't auto-rebuild on further
  saves until `npm run start:dev` is relaunched.
- `npx prisma migrate dev` refuses to run in this shell ("Prisma Migrate has detected that the
  environment is non-interactive"), including with `--create-only`. Workaround: hand-write the
  migration folder (`prisma/migrations/<timestamp>_<name>/migration.sql`, matching the DDL style
  of existing migrations — e.g. `DECIMAL(65,30)` for a bare `Decimal` field) and apply it with
  `npx prisma migrate deploy`, which runs non-interactively. Check the target table's existing row
  count first if the migration adds a required column or a new unique constraint — `migrate deploy`
  will still fail loudly (not silently) if the data doesn't fit, but hand-writing the backfill
  logic yourself (see the `Sku.categoryId` migration for an example) is on you, `migrate dev` isn't
  there to generate it for you this way.

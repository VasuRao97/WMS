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
unaffected (open to any authenticated role). Every master-data controller (Warehouses, SKUs,
Customers, Users) now uses this: `common/tenant.util.ts` exports `MASTER_DATA_READ_ROLES`
(`COMPANY_ADMIN`/`WAREHOUSE_MANAGER`/`WAREHOUSE_SUPERVISOR` — `OPERATOR` excluded) and
`MASTER_DATA_WRITE_ROLES` (`COMPANY_ADMIN`/`WAREHOUSE_MANAGER` — `WAREHOUSE_SUPERVISOR` also
excluded), applied per-handler (`@Roles(...MASTER_DATA_READ_ROLES)` on every `GET`,
`...MASTER_DATA_WRITE_ROLES` on `POST`/`PATCH`/import). Delete endpoints stay tighter still,
`@Roles('COMPANY_ADMIN')` only (2026-08-23). Follow this same pattern — read/write role constants
from `tenant.util.ts`, not a hand-typed `@Roles()` list — for any new master-data controller. See
"Role & Access model" below for the full picture (who can see/create/edit what, and why).

### Role & Access model (2026-08-24)
The full behavior — hierarchy, visibility, warehouse-scoping, login rules — is written up for
non-developer reference at `docs/roles-and-access.md`; this section is the terse version for
working in the code.

**Hierarchy.** `COMPANY_ADMIN > WAREHOUSE_MANAGER > WAREHOUSE_SUPERVISOR > OPERATOR`
(`SUPER_ADMIN` is platform-level, orthogonal to this — see below). One role per person, no
per-warehouse role variance. `users/users.service.ts`'s `CREATABLE_ROLES` map is the source of
truth for who can create/edit whom: `COMPANY_ADMIN` can create any role including another
`COMPANY_ADMIN` (co-admins are allowed); every other role can create only roles *strictly below*
itself (`WAREHOUSE_MANAGER` → Supervisor/Operator, `WAREHOUSE_SUPERVISOR` → Operator only,
`OPERATOR` → nothing). The same map gates *editing* an existing user (their current role must be
in the editor's creatable set) — `frontend/src/UsersPage.tsx` keeps a client-side mirror of this
map purely for UX (filtering the role dropdown); the server copy in `users.service.ts` is the real
enforcement, don't trust the client one.

**Visibility.** `OPERATOR` has zero master-data visibility — no Warehouses/SKUs/Customers/Users
pages, by design (their eventual surface is transactional/handheld task screens, none built yet).
`WAREHOUSE_SUPERVISOR` has the same visibility as `WAREHOUSE_MANAGER` but read-only (blocked from
`MASTER_DATA_WRITE_ROLES`). SKU stays **unscoped** — every readable role sees the full company
catalog, since a SKU isn't owned by any one warehouse. Warehouse, Customer, and User are **scoped**
to `assignedWarehouses` for Manager/Supervisor (`common/tenant.util.ts`'s `ownWarehouseIds()` +
`WAREHOUSE_SCOPED_ROLES`): a Warehouse is visible if its `id` is in the viewer's own
`assignedWarehouses`; a Customer is visible if it has at least one `CustomerShipTo` whose
`warehouseId` matches one of the viewer's warehouses (a customer with **no** warehouse-linked
ship-to is invisible to Manager/Supervisor — a deliberate conservative default, not a fallback to
full visibility, until an Admin/Manager links one); a User is visible if they share at least one
warehouse with the viewer (or are the viewer themself). `COMPANY_ADMIN`/`SUPER_ADMIN` are never
scoped this way — full company (or, for `SUPER_ADMIN`, cross-company) visibility always.

**Login identity.** `COMPANY_ADMIN`/`WAREHOUSE_MANAGER` accounts require a real email address
(`EMAIL_REQUIRED_ROLES` in `users.service.ts`, checked against `common/validation.util.ts`'s
`EMAIL_REGEX`); `WAREHOUSE_SUPERVISOR`/`OPERATOR` log in with any unique ID (shop-floor staff
often don't have one). `User.email` is `@unique` globally regardless of shape — this already
satisfies "every login ID is unique for KPI attribution" with no extra schema work.
`frontend/src/LoginPage.tsx`'s email field is `type="text"`, not `type="email"` — deliberately, so
the browser's native email-format validation doesn't block an ID-style login before it ever reaches
the backend (this was a real bug caught 2026-08-24, not a stylistic choice).

**Deactivation.** Same warehouse-overlap + creatable-role check as editing (`assertEditAccess` in
`users.service.ts`); nobody can deactivate themselves. No hard delete/Delete All for `User` —
deactivate (`isActive`) is the only destructive-ish action, partly by convention and partly because
`User` has many non-cascading relations (`receiptsCreated`, `putawaysCompleted`, etc.) a real delete
would collide with. `JwtStrategy.validate()` re-checks `isActive` against the DB on every
authenticated request (one extra `prisma.user.findUnique`, not just a token-signature/expiry check)
— without this, deactivating someone didn't invalidate a JWT they already held, so they'd keep
working for up to the 8h token lifetime (`auth.module.ts`'s `expiresIn`) regardless. Predates this
module (the gap, not the fix) — found and closed 2026-08-24.

**Self-editing your own account.** `assertEditAccess` always lets you reach your own record —
the creatable-role/warehouse-overlap checks it otherwise runs exist to gate access to *other*
people's accounts, not your own (a Manager couldn't self-edit at all before this, since no role's
`CREATABLE_ROLES` entry includes itself except Admin's). Two things stay off-limits even on
yourself: `update()` always rejects a `role` change on your own record (else Admin's own
all-roles-includes-itself entry would let them accidentally demote themselves out of the company's
only admin seat), and `email` (the login ID) is immutable after creation for everyone, self-edit or
not — these IDs anchor per-person KPI history, so a rename attempt is rejected outright rather than
silently ignored (a real bug this used to have: the edit form let you type a new login ID, and the
backend just dropped it without telling you).

**Editing someone whose `assignedWarehouses` spans more than the editor's own scope.** The schema
allows a Supervisor/Operator to be shared across warehouses under different Managers (flexible
cardinality, by design). `update()` must never re-validate — or silently drop — the portion of
their assignment the editor can't see: it fetches the target's current `assignedWarehouses`,
splits off whatever falls outside the editor's own `ownWarehouseIds()`, and unions that back in
untouched after validating only the editor's own-scope portion of the submitted list. Without this,
a Manager editing even just a subordinate's `name` would either get a confusing 403 (the invisible
warehouse id fails their own scope check) or, worse, silently strip that other Manager's assignment
— caught and fixed 2026-08-24. `frontend/src/UsersPage.tsx`'s edit form only pre-fills warehouse ids
that are actually in the current viewer's own picker options, for the same reason, plus shows a
"+N warehouse(s) outside your access" note so it's not invisible that more exists.

**Bulk import** (`POST /users/import`, `UsersService.bulkImport`) — same shape as the Warehouse/SKU/
Customer import controllers (xlsx → per-row validation → success/error results), added for
onboarding a large batch (100+) of Operators at once, where the manual one-by-one form doesn't
scale. Gated the same as manual create (`CAN_MANAGE_USERS`, not `MASTER_DATA_WRITE_ROLES` — a
Supervisor bulk-importing Operators is exactly as legitimate as adding one by hand), and reuses
`validate()`/`resolveWarehouseIds()`/`CREATABLE_ROLES` per row (CLAUDE.md's "one function, two
callers" convention) — a Manager's bulk import is exactly as scope-limited as their manual create.
Warehouse assignment in the sheet is a single "Warehouse Code(s)" column, comma/semicolon-separated,
resolved to ids via `resolveWarehouseCodesToIds()` then validated through the same
`resolveWarehouseIds()` the manual path uses.

**`functionTag`** (free-text field on `User`, e.g. "Inbound Sup", "Picking") is descriptive only —
captures the Supervisor/Operator specialization from the client's role sheet for future KPI/
task-routing reporting, but no permission check reads it. Real per-function permission narrowing
(a dock-supervisor-style split where Inbound Sup and Outbound Sup have different system access) is
explicitly deferred, same as it was before this field existed.

**Login ledger.** `LoginEvent` (`userId`, `loggedInAt`) is an append-only table — one row per
successful login, never updated or deleted, the same "never UPDATE, always INSERT" shape as
`StockMovement`. `User.lastLoginAt` is the cached "last seen" convenience read off it, kept in sync
in the same `$transaction` (`AuthService.recordLogin()`, called from both `login()` and
`registerCompany()` — registration auto-logs the new Admin in too, so that counts). A failed login
attempt never reaches `recordLogin()` — only a successful one. `UsersPage.tsx` shows "Days Active"
(computed client-side from `createdAt`, no backend field for it) and a clickable "Last Login" that
expands the row into the full history (`GET /users/:id/login-history`, `UsersService.
getLoginHistory()`, capped to the most recent 100) — same visibility rule as `findAll` (self, or
shares a warehouse for a scoped role, or Admin sees everyone), deliberately *not* the stricter
`assertEditAccess` rule, since viewing history is a read, not an edit. First-level capture + a
quick-look viewer only (2026-08-24) — the actual manpower-attendance report/rollup (days present, a
daily attendance view) built on top of this data is still deliberately not built.

**Deliberately deferred** (don't build without re-confirming): a configurable per-company
permission matrix (toggle-based, replacing the hardcoded `CREATABLE_ROLES`/`MASTER_DATA_*_ROLES`
constants above — raised and consciously postponed 2026-08-24, revisit once it's clear which rules
actually need to vary by customer); network/IP-restricted logins for ID-based (Supervisor/Operator)
accounts; zone-level task assignment (Locations/Bins now exists, but the task-assignment logic
itself is still not built); `SUPER_ADMIN` account
creation (still no controlled way to create one); the actual manpower-attendance report/rollup
built on top of `LoginEvent` (raw data capture + a quick-look history viewer exist, the report
itself doesn't); tracking *who created* a given user account (a `createdById` audit field) —
considered alongside the login ledger, explicitly not wanted for now.

Verified end-to-end (creation hierarchy allow/deny, warehouse-scoped visibility, cross-scope edit
denial, self-deactivation block, login-format rules) via a throwaway-company test script,
37/37 checks passing, 2026-08-24. A second throwaway-data pass (self-edit access, self-role-change
block, login-ID immutability, multi-warehouse-subordinate edit preservation, bulk import allow/deny
including the cross-role and duplicate-in-file cases) added 19/19 more the same day after a
self-review caught the four gaps above. A third pass confirmed the `JwtStrategy` deactivation fix
(3/3 — same token rejected on the very next request, not up to 8h later; re-login also blocked) and
a fourth confirmed the login ledger (6/6 — registration and login both record a `LoginEvent` and
update `lastLoginAt`, a failed login records neither, `GET /users` exposes both fields) — see git
history for the session if the detail is needed.

### Locations/Bins zone & storage model (2026-08-24)
`locations/` module + `LocationsPage.tsx` — the last of the five Master Data entities, built after
a long design pass (see git history/conversation for the full reasoning) rather than a quick
scaffold, since real bin generation needed its own numbering/hierarchy/capacity decisions first.

**Two independent tags, not one.** `zoneType` (`LocationZoneType` enum, 14 values —
`UNLOADING_STAGING`, `LOADING_STAGING`, `ACTUAL_STORAGE`, `FORWARD_PICK`, `PICK_FACE`,
`PACKING_KITTING`, `CROSS_DOCK`, `SLOB`, `RETURNS`, `RE_PUTAWAY`, `QC_HOLD`,
`TEMP_CONTROLLED_STORAGE`, `HAZMAT`, `DAMAGE_SCRAP`) says what a bin is *for*; `storageType` (free
text, same convention as `WarehouseStorageType.storageType` — `GROUND_FLOOR | SPR | DRIVE_IN |
ASRS | STILLAGE`) says how it's *physically built*. `MIX` is deliberately excluded from
`Location.storageType` — that value only ever means "warehouse hasn't broken this down yet" at
the `WarehouseStorageType` capacity-planning level; a real physical bin is always concretely one
of the five. Forward Pick and Pick Face stay separate zone types on purpose (Forward Pick = fast-
movers near staging; Pick Face = rack-based picking positions), not collapsed into one.

**Three field groups on one table**, populated per `storageType` (a `Location` row is always
exactly one of these, so — same reasoning as `Warehouse`'s optional-per-`nodeType` fields — this
stays one table with unused fields left null, not three separate tables):
- **Rack** (`SPR`/`DRIVE_IN`/`ASRS`): `aisle`, `rack` (bay), `level`, `bin` (shelf-slot, defaults
  `'1'`), `depth` (multi-deep drive-in lane position, 1=front). Code: `A01-R05-L02-B01`, or with
  `depth` appended (`-D2`) for a multi-deep lane position.
- **Ground** (`GROUND_FLOOR`, block-stacked floor storage): `aisle`, `block`, `depth`/`width`
  (footprint, both required), `height` (stacked layers, default 1). Code: `GF-A01-BLK07`.
- **Stillage** (`STILLAGE`, cages stacked on cages): `aisle`, `stack`, `height` (required — how
  many stillages stacked), `depth`/`width` (default 1 each, for when stillage columns themselves
  sit in a grid rather than a single column). Code: `ST-A01-04`.

`depth`/`width`/`height` are shared dimensional fields whose meaning depends on `storageType`, not
three separate ground-only concepts — a design realization mid-pass (rack drive-in lanes have
depth too; stillage stacks can have depth/width too, not just height).

**Capacity is derived, never stored** — same "always derived" philosophy as on-hand stock.
`LocationsService.attachCapacity()` computes `depth × width × height` for `GROUND_FLOOR`/
`STILLAGE` rows only (a rack bin is individually addressable, capacity is implicitly 1, not shown).

**Multi-SKU sharing per bin, tiered by ABC class** — `WarehouseStorageType` gained
`maxSkusClassA`/`maxSkusClassB`/`maxSkusClassC` (default 1/2/null-unbounded), config only, not
enforced yet. Deliberately *not* scoped to ground/floor storage alone — a multi-deep drive-in
lane's farthest-from-dock positions sharing two C-class SKUs is exactly the kind of case this
needs to cover too, and since `WarehouseStorageType` is already keyed per `storageType`+category,
this falls out for free (no extra field needed). Actually deciding *which* bins get this
treatment (e.g. "farthest from dock → C-class") is Putaway/slotting logic — explicitly deferred,
not built.

**`normalizeCode()` (`common/normalize.util.ts`) now also strips `&`** — "Damage & Scrap" used to
normalize to `DAMAGE_&_SCRAP` (ampersand survived, flanked by underscores) instead of
`DAMAGE_SCRAP`, failing validation. Caught and fixed during this module's build, 2026-08-24.

**Deliberately deferred** (raised and consciously postponed during the design pass, don't build
without re-confirming): bulk range-generation ("Aisle A, Racks 1-20, Levels 1-4 → auto-create 80
bins") and any visualization of a generated layout — parked for a dedicated follow-up conversation
once the shape of that tool is worked out; Excel bulk import for Locations (today's build is
manual create/edit/list/deactivate + Delete All only, same starting scope every other master-data
module had before its own bulk tooling got added); Putaway/slotting logic that actually reads
`maxSkusClass*`/bin position to decide placement (a smart-allocation value-add — e.g. reserving the
least-accessible rack positions for slow-moving C-class SKUs — raised explicitly as a future
feature, not scaffolded); removing `MIX` from `WarehouseStorageType` itself (only excluded from
`Location.storageType`, the source stayed untouched by deliberate choice — see git history if this
gets revisited).

**Zone Type → Storage Type narrowing is UI-only, not backend-enforced** (`ZONE_STORAGE_COMPAT` in
`LocationsPage.tsx`, 2026-08-24) — e.g. a Staging/Cross-Dock/QC Hold/etc. bin's Storage Type
dropdown only offers Ground/Floor, Pick Face only offers the three rack types, since that's what's
realistic in practice. `LocationsService` on the backend still accepts *any* valid zoneType+
storageType combination — this was a deliberate choice (a wrong UI narrowing is a one-line fix; a
wrong hard backend rule blocks a real warehouse's real layout) but it does mean a future bulk
importer or a direct API call can create a combination the manual UI would never offer (e.g. a
Rack-based Loading Staging bay). Flagging this now so it isn't a surprise later: if that gap ever
causes real data-quality issues, promote `ZONE_STORAGE_COMPAT`'s mapping into a backend check
(`LocationsService`'s `buildLocationFields`) rather than assuming the UI alone is enough.

Verified end-to-end via a throwaway-company test script (rack/ground/stillage creation and code-
building, capacity derivation, all rejection paths — missing required fields per storage type,
`MIX` rejected as a bin storageType, bad zoneType/category, duplicate code — role/warehouse scoping
allow+deny incl. Operator's zero visibility, update() clearing stale fields across a storageType
switch, deactivate/reactivate, Delete All both blocked-when-linked and success-when-clean paths),
44/44 checks passing, plus a manual UI pass confirming the dynamic form fields switch correctly per
Storage Type and a real Ground/Floor location round-trips through the browser. 2026-08-24.

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
repeated-Bill-To-ID-per-row grouping pattern, Delete All). **User Master** (`users/` module +
`UsersPage.tsx`, 2026-08-24) — a hierarchical creation/edit model (not flat Admin-only), full
role/warehouse-scoping enforcement across every master-data controller, bulk Excel import for
onboarding large Operator batches, self-service edit of your own name/password (role and login ID
frozen), no Delete All (deactivate only), an append-only login ledger (`LoginEvent`) surfaced as
"Days Active"/"Last Login" on the list (first-level capture for a future attendance report — not
built yet); see "Role & Access model" above for the full behavior. **Locations/Bins** (`locations/`
module + `LocationsPage.tsx`, 2026-08-24) — the fifth and last Master Data entity: a 14-value
`zoneType` (function) independent of a 5-value `storageType` (rack/ground/stillage physical
build), three field groups on one table depending on `storageType`, derived (never stored)
capacity for ground/stillage bins, and role/warehouse scoping matching Warehouse/Customer. No bulk
range-generation or Excel import yet (manual create/edit/list/deactivate + Delete All only) — see
"Locations/Bins zone & storage model" above for the full design and what's deliberately deferred.
See "Platform-managed reference data" above for `ProductCategory`/`CategoryPackSpec`, the
repository pattern behind several of these.

All three master-data pages (`WarehousesPage.tsx`, `SkusPage.tsx`, `CustomersPage.tsx`) now have
a manual "Add ___" form, collapsed behind a `showForm` toggle (`▸ Add ___ manually` /
`▾ Hide manual entry`, closed by default) — bulk Excel import is the primary path for these
master lists at real scale, manual entry is a secondary affordance. Apply the same toggle
pattern to any new master-data page's manual-create form.

All five Master Data entities named in the module build order above (warehouses/locations/SKUs/
customers/users) are now built — see immediately above, "Role & Access model", and "Locations/Bins
zone & storage model" further up for Users' and Locations' full behavior respectively. Inbound is
next per the module build order — Locations/Bins existing (with real zone types and physical
addressing, not just a schema table) is what unblocks it.

Also explicitly deferred (don't assume these exist): `SUPER_ADMIN` account creation, a
configurable per-company permission matrix (role/warehouse access rules are enforced but currently
hardcoded, not client-editable — see "Role & Access model"), network/IP-restricted logins,
zone-level task assignment, a company-admin *invite-link* flow (today's flow is direct
password-setting by the creating Admin/Manager/Supervisor, not an emailed invite — no
email-sending infrastructure exists in this project),
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

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
without re-confirming): Putaway/slotting logic that
actually reads `maxSkusClass*`/bin position to decide placement (a smart-allocation value-add —
e.g. reserving the least-accessible rack positions for slow-moving C-class SKUs — raised explicitly
as a future feature, not scaffolded); removing `MIX` from `WarehouseStorageType` itself (only
excluded from `Location.storageType`, the source stayed untouched by deliberate choice — see git
history if this gets revisited).

### Locations/Bins: range generator, Excel import, edit UI, filtering (2026-08-24)
Added in a follow-up pass once the core module above was built and committed.

**Range generator** (`POST /locations/generate`, `LocationsService.generate()`) — expands a Rack
range (`rackRange` × `levelRange` × `binRange` × `depthRange`), a Ground `blockRange`, or a Stillage
`stackRange` into many individual `Location` rows in one call (e.g. Aisle A01, Rack Range 01-20,
Level Range 01-04 → 80 rows). A range field accepts `01-20` (zero-padding preserved from whichever
side of the dash has more digits — `expandRange()` in `locations.service.ts`) or a bare value with
no dash, repeated as a fixed value for every generated row. Ground/Stillage's `depth`/`width`/
`height` stay **fixed across the whole batch** — only the Block/Stack identifier varies per row;
this matches the design-pass conclusion that those dimensions describe one footprint shared by
every block/stack in a batch, not something that varies row-to-row. Capped at 2000 locations per
call (`MAX_GENERATE_BATCH`) so a mistyped huge range fails fast with a clear message. Per-row
results (success/error, same shape as bulk import below) so a partially-conflicting batch still
creates everything that didn't collide, rather than all-or-nothing.

**Rack Depth auto-expands from a bare number** (follow-up fix, 2026-08-24) — a real gap caught in
practice: typing "2" meaning "this Drive-in lane is 2 pallets deep" only created the *back* slot
(`depth=2`), never the front one, because a bare range value has always meant "repeat this one
fixed value," not "every position up to it." Now, only for the Depth field, a bare number N gets
rewritten to `1-N` before `expandRange()` runs, so "2" correctly creates both `depth=1` and
`depth=2`. An explicit range (`3-5`) still means exactly those positions unchanged — that's the
rare deliberate case of adding specific positions to a lane that's already partly built. This bare-
vs-range distinction is Depth-specific — Rack/Level/Bin/Block/Stack ranges still mean "repeat this
fixed value" for a bare input, which is exactly correct there (a bare "05" for Rack means "just
rack 05," not "racks 1 through 5").

**"Second range" fields generate both flanks of one aisle in a single call** (follow-up feature,
2026-08-24) — real warehouses put racking or floor blocks on *both* sides of one aisle, and both
sides always share the same Depth (confirmed, not left open). `rackRange2` / `blockRange2` are
optional companions to the primary `rackRange` / `blockRange`: give one and the generator builds
both sides under the *same* Aisle, same Depth/Width/Height, in one call — e.g. Rack Range 01-10 +
Second Rack Range 11-20 → 20 rows, one Aisle. Omitting the second range behaves exactly as before
(fully backward compatible). Stillage was deliberately left out of this — a stillage stack isn't a
two-flank aisle structure the way rack rows and floor blocks are.

Each row from a second range is now also tagged `side: 'B'` on `Location` (a nullable field added
2026-08-25, blank for the primary range) — originally this design note said no "side" field would
ever be needed, reasoning that continuous non-overlapping numbers (01-10 + 11-20) already
disambiguate the two flanks. That held for *storing* the data, but broke down for the Plan View
visualizer, which had no way to tell "one real flank" apart from "two" without it — see "Locations/
Bins: Plan View visualizer" below for the full story. `side` also enables a second, real-world-common
convention the original design didn't anticipate: a **"Mirror same numbers on other side"** checkbox
in the generator UI that reuses the *same* rack/block numbers on both flanks (e.g. 01-15 both sides)
rather than requiring continuous non-overlapping ones — `buildCode()` appends the side letter to a
secondary row's code (`R01B` vs `R01`) so this never collides despite reusing numbers.

**Excel bulk import** (`POST /locations/import`, `LocationsService.bulkImport()`) — same
xlsx → per-row validation → success/error results shape as Warehouse/SKU/Customer/User, reading a
sheet named exactly `Location Import` (read by name, not position — see the established
convention). Unlike those other imports, there's no repeated-key grouping pass: each row already
*is* one Location. Resolves `Warehouse Code` per row via `resolveWarehouseCodeToId()` (same
`companyId_code` lookup + `WAREHOUSE_SCOPED_ROLES` access check as everywhere else).

**Both the generator and the import reuse a new shared `prepareRow()`** (validate + build fields +
resolve category + check warehouse access, returning errors instead of throwing) that `create()`
also now calls — refactored so all three insertion paths (single create, range-expand, Excel row)
run through identical validation, rather than the generator/import duplicating `create()`'s logic
with subtly different bugs. Same "one function, many callers" convention as
`SkusService.validateSkuData`.

**Edit UI** — `LocationsPage.tsx`'s "Add Location" form now doubles as the edit form: `editingId`
state, `startEdit(location)` pre-fills every field from the row and flips the form to "Edit
Location" / "Save Changes" + "Cancel", `handleSubmit` POSTs or PATCHes depending on whether
`editingId` is set. Real bug caught building this: Prisma serializes an unset optional int
(`depth`/`width`/`height`) as JSON `null`, not an absent key — `startEdit`'s original `!==
undefined` check let `null` through, which then stringified to the literal text `"null"` and failed
backend validation ("must be a positive whole number") on every edit of a rack-storage row with no
Depth set. Fixed to `!= null` (catches both). Worth remembering for any other frontend code reading
an optional Prisma field back into form state.

**Search/filter row** above the table — Warehouse/Zone Type/Storage Type dropdowns plus a free-text
search matching code/aisle/rack/level/bin/block/stack/zone, all client-side against the
already-fetched list (no backend endpoint changes) — this was fine at the scale tested but will
need to become server-side filtering once a real warehouse's location count gets large enough that
fetching the full list up front stops being practical.

Verified end-to-end via a throwaway-company test script (23/23: rack/drive-in/ground/stillage range
generation including zero-padding and a 4x20-row batch, re-generating an identical range correctly
blocked as all-duplicate, the `MAX_GENERATE_BATCH` cap, generator role/warehouse scoping, Excel
import success/duplicate-in-file/bad-warehouse-code/`MIX`-rejected/wrong-sheet-name paths) plus a
manual browser pass (generator creating 10 real rows through the actual UI, the edit-form bug
above caught and confirmed fixed live, search and Storage Type filtering both narrowing the visible
list correctly). The bare-depth-auto-expand and second-range fixes above were verified in their own
follow-up pass (14/14: bare "2"/"5" expanding to the right position sets, an explicit range like
"3-5" staying exact, zero-padded bare values, both-sides generation for Rack and Ground, and
confirming an omitted second range still behaves exactly as before) plus a live browser check (Rack
Range 01-03 + Second Rack Range 04-06 + bare Depth "2" → 12 real rows, Racks 01-06 each with both
Depth 1 and Depth 2, confirmed through the actual UI).

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

### Locations/Bins: Plan View visualizer (2026-08-25)
`LocationsPlanView.tsx` + a Table View/Plan View toggle on `LocationsPage.tsx` — the last piece
needed to call Master Data fully done: a top-down structural floor plan so a generated/imported
layout can actually be looked at and confirmed against the real warehouse, not just spot-checked
row by row. Built after its own design pass (separate from the original Locations/Bins numbering
conversation) — see git history for the full back-and-forth; this section is the resulting shape.

**Structural only, static, whole-warehouse.** Shows which bins *exist*, not what's in them (no
occupancy — Inbound/Putaway don't exist yet, so there's no real stock-in-bin data to show anyway).
Pure client-side render of whatever's already in `locations` state for the selected Warehouse — no
new backend endpoint, no live/interactive click-to-inspect yet (both deliberately deferred, along
with Zone Type color-coding — the component is structured so a color legend can be added later
without a rewrite, but nothing renders in color today).

**One vertical aisle strip per distinct `aisle` value**, aisles laid out left-to-right in ascending
aisle-code order (natural/numeric-aware sort, so `"2" < "10"`). Racks/blocks/stacks flank both sides
of each aisle:
- **Side split comes from a real, persisted `Location.side` field — never guessed from the numbers.**
  The very first version of this view inferred which flank a row belonged to by sorting an aisle's
  rack/block numbers and cutting them at the midpoint (lower half → right, upper half → left). That
  was wrong and caught immediately on real data (2026-08-25): a warehouse aisle generated with a
  single `Rack Range = 01-15` and nothing in `Second Rack Range` is genuinely single-sided (e.g.
  racking against a wall) — the midpoint guess still split it into two flanks and drew the same
  aggregated content on both, inventing a second flank that didn't exist. Root cause: the database
  had no record of which of the two range boxes a row actually came from, so the view had nothing
  reliable to split on. Fixed by adding `side` (nullable string) to `Location`, set **only** by
  `LocationsService.generate()` — blank for rows from the primary range, `'B'` for rows from a
  Second Range (typed manually, or via the "Mirror same numbers on other side" checkbox added to the
  generator UI at the same time). The Plan View now reads this directly: no `side: 'B'` row in an
  aisle → one flank, full stop; some do → those are the real second flank (left), the rest (blank
  `side`) are the primary/right flank. Existing rows generated before this field existed have no
  `side` at all and correctly render single-flank — a real two-flank aisle generated pre-fix needs
  regenerating (with the mirror checkbox) to show as two flanks again.
- **The "mirror" checkbox reuses the SAME rack/block numbers on both flanks** (e.g. Rack Range
  `01-15` on both sides, not `01-15` + `16-30`) — this is a distinct real-world convention from the
  original "continuous numbering" one (`01-10` + `11-20`), and both are supported side by side.
  Reusing the same number on both flanks would collide on the generated `code` (which never
  included a side marker), so `buildCode()` now appends the row's `side` letter directly after the
  rack/block segment **only when `side` is set** — primary-side codes are completely unchanged
  (`A01-R01-L02-B1`), secondary-side codes get the letter (`A01-R01B-L02-B1`). A manually-typed
  Second Range with genuinely different numbers still works exactly as before (no letter needed for
  uniqueness, but one gets appended anyway now for consistency — one rule, not two).
- **Rows pair by position, not by raw stored number** — the 1st position on the right flank (nearest
  the corner) draws in the same row as the 1st position on the left flank, 2nd with 2nd, etc.,
  regardless of what their underlying numbers are (even when both flanks reuse the very same
  numbers, per the mirror case above — "1 opposite 1").
- Every aisle shares the same bottom row line (row 0 = nearest the corner) as every other aisle in
  the plan, so a taller aisle just extends further up rather than floating independently.

**Every footprint cell is a fixed-size box** — Rack's Depth/Level range, Ground/Stillage's
`depth×width×height` all render as *text inside* the cell rather than scaling the box wider for
multi-deep storage (a deliberate v1 simplification — a Rack footprint sharing multiple Levels/Bins
collapses to one box with an `L{min}-L{max}` line, since height/level is orthogonal to a top-down
plan and out of scope until a level-toggle is built). A cell with any inactive location inside it
gets a dashed border + greyed text rather than being hidden — a structural QA view shouldn't quietly
drop a location just because it was deactivated.

**Manual create and Excel import never set `side`** — there's no "second range" concept on either
path, so a hand-typed or imported rack always renders single-flank, which is correct (it isn't
implying a mirrored twin exists elsewhere). `update()` doesn't touch or clear `side` either — editing
a generator-created row leaves its flank assignment intact.

Verified in two passes. First pass (against the original, since-replaced midpoint-guess logic):
throwaway company, one aisle each of both-flank SPR, both-flank Drive-in with the bare-depth
auto-expand, both-flank Ground/Floor, single-flank Stillage (50 locations) — confirmed cell text and
SVG geometry matched the (at-the-time) algorithm. That pass didn't catch the single-sided bug because
every generated test aisle happened to use two ranges. Second pass, after the `side` fix (2026-08-25,
16/16 checks): a throwaway-data script covering single-sided-only (15 racks, one `rackRange`, the
actual bug scenario), a manually-typed continuation Second Range, and the mirror checkbox (same
numbers both sides) — confirmed via the real API that `side`/code-suffix land correctly in the
database for all three cases, plus confirmed manual create never sets `side`. Then re-verified live
through the actual browser UI (not just the API): generated a mirrored aisle by actually checking the
new "Mirror same numbers" checkbox in the real form, confirmed the Second Range input correctly
disables while checked, confirmed the resulting Table View codes carry the `B` suffix, and confirmed
the Plan View SVG draws exactly 15 single-flank cells for the wall-case aisle and exactly 5+5 cells at
two distinct x-positions (a real left/right split) for the mirrored aisle. Cleaned up via Delete All
afterward in both passes (no company-delete endpoint exists, so the empty throwaway companies/logins
are left behind, same as prior sessions).

**Two more corrections caught looking at real generated data** (same day, 2026-08-25, after the
`side` fix above):
- **Aisle growth direction was backwards.** New aisles were being added to the *right* of the
  previous one; they should grow to the *left*, same direction the corner-anchoring already governs
  everywhere else (row 0 nearest the corner, right flank = lower numbers). Fixed by placing aisles
  in a single right-to-left pass — Aisle 1 (lowest code) now sits closest to the bottom-right corner,
  each further aisle's right edge sits `AISLE_GAP` left of the previous aisle's left edge.
- **A multi-deep Rack lane drew as one box with "Depth 1-3" as text**, which reads as a single pallet
  even though a 3-deep lane is 3 real, separately-addressable `Location` rows. Fixed: a Rack
  position now draws one box **per distinct depth value** (side by side, extending further from the
  aisle the deeper it goes), each box showing just its own `D{n}`/Level text — single-deep racks are
  unaffected (still one box, no `D1` label, since depths.length is 1). `Cell` went from a single
  fixed-size box to a `boxes[]` array with a `totalWidth`, and the per-aisle/per-flank width used for
  layout is now the *max* cell width in that flank rather than a constant — cells can be different
  widths within the same flank now (a 1-deep and a 3-deep rack side by side), anchored so they still
  align flush against the walkway on the near edge and only the far edge is ragged.
- **Deliberately left unchanged for now**: Ground/Floor and Stillage still show `depth×width×height`
  as text in one box, not sub-boxes — unlike Rack, their depth is a dimension on a single database
  row (the unique-code constraint on `GF-{aisle}-BLK{block}` guarantees exactly one row per block),
  not multiple separate rows, so a sub-box split there would be purely decorative rather than
  one-box-per-real-record. Whether that should still visually expand is an open question, raised and
  parked, not decided against.

Verified against fresh throwaway data (a single-sided 15-rack aisle coded `"1"`, a 3-deep mirrored
Drive-in aisle coded `"2"`) via the real API, then loaded through the actual browser: confirmed
Aisle `"1"`'s label sits near the SVG's right edge and Aisle `"2"`'s sits well to its left; confirmed
exactly 45 boxes total (15 single-depth + 5 positions × 3 depths × 2 flanks); confirmed the 3 depth
boxes per position sit at three evenly-spaced x-positions (110px apart, matching box width) extending
outward from the aisle on both flanks. Cleaned up via Delete All afterward.

### Locations/Bins: Section field (2026-08-25)
`Location.section` — a manually-typed physical section name, added specifically for the Plan View
once real generated data made clear that `aisle` alone (often a bare number like `"1"`) isn't a
human-friendly enough label, and that a proper naming layer needed to be **stored**, not just
computed for display, so it can also show up in exports and be used for reconciling. Distinct from
`zone` (an existing free-text label with no consistency rule) and from a future **Zone** concept
(grouping *several* Aisles together, e.g. Zone 1 = Aisles 1-4 — raised in the same conversation,
explicitly not built yet) — `section` is a **1:1 invariant with Aisle**, one Section per Aisle
always, never spanning more than one.

**Deliberately manual, not auto-lettered.** An early proposal was to auto-assign A/B/C by the Plan
View's own left-to-right aisle order — rejected: a real Section name is often tied to something
physical (a building landmark, a client's own floor plan already in use) rather than a neat
alphabetical sequence, so it has to be typed, not computed.

**The 1:1 invariant is enforced in the service layer, not the DB** — `assertSectionConsistency` in
`locations.service.ts`, called from `prepareRow` (so `create()`/`generate()`/`bulkImport()`/
`update()` all go through it, same "one function, many callers" shape as everywhere else in this
module). Given a Warehouse + Aisle + an incoming Section value: no existing row on that Aisle has a
Section yet → the incoming value is used as-is (including blank). An existing row already has one →
blank incoming value **auto-inherits** it (so you don't have to retype a Section on every later
generate/import batch for the same Aisle), a matching value (case-insensitively) is accepted and
normalized to the existing casing, a genuinely different value is rejected with a clear error naming
the conflict. `update()` passes its own `id` as an `excludeId` so editing a location's *own* Section
doesn't spuriously compare against itself and permanently block ever changing it.

Wired through the same places `zone` already was: the generator form, manual create/edit form, Excel
import/export (`Section` column, same "only fill what applies" convention), search/filter, and the
Plan View — each aisle strip now shows `Section {name}` prominently with `Aisle {code}` as smaller
secondary text, falling back to just the Aisle code alone (unchanged from before) for an aisle that
has no Section set yet.

Verified via a throwaway-company test script (13/13): first batch on an Aisle sets its Section;
a second batch on the same Aisle with Section left blank auto-inherits it; an explicit matching value
succeeds; a case-different value (`"a"` vs `"A"`) is accepted and normalized; a genuinely conflicting
value is blocked with the right error message; a different Aisle gets its own independent Section
freely; manual create both inherits correctly and is blocked on a genuine conflict; the export
endpoint responds. Then re-verified live through the actual browser: Table View's new Section column,
the edit form correctly pre-filling an existing Section, and the Plan View showing "Section A" /
"Aisle 1", "Section B" / "Aisle 2" for two seeded aisles and a plain "3" (no special treatment) for a
third aisle that was deliberately generated with no Section at all, confirming the graceful fallback.

### Locations/Bins: Rack Name and `flankNumber` — `side` retired (2026-08-25)
Same day as Section, a follow-up conversation nailed down a real physical naming scheme for
individual Rack positions (not just Aisles) — "Rack Name", e.g. `R1-04` or `R1-04-D2` for a
multi-deep box — and in the process **retired the `side` field** (added earlier that same day) in
favor of a proper stored `Location.flankNumber` (nullable int). This section is the terse version;
schema.prisma's comment on `Location.flankNumber` and `LocationsPlanView.tsx`'s file-level comment
carry the full reasoning.

**Why `side` wasn't enough.** `side` (blank/`'B'`) only ever answered "primary or secondary flank of
*this* aisle" — good enough for the Plan View's left/right split, but Rack Name needed something
with a real, globally-unique identity (`R1`, `R2`, `R3`...) that Putaway/Pick logic could reference
later, not just a local flag. `flankNumber` replaces it entirely: within one aisle, whichever number
is lower is the primary/right flank, the higher (if it exists) is secondary/left — derived by
comparison, no separate flag needed. `side` was dropped from the schema the same day it was added
(only ever used by throwaway test data — confirmed no real data depended on it before dropping).

**Allocation is warehouse-wide and never wastes a number** (`LocationsService.resolveFlankNumber` +
`nextFlankNumber`) — confirmed explicitly, not assumed: a single-sided aisle consumes exactly one
number, the next aisle's first flank continues right on from there (no reserved-but-unused slot). A
flank that already has a number (adding to an aisle already built) reuses it; a brand-new flank gets
`MAX(flankNumber) + 1` across the whole warehouse. **Two flanks of the same aisle are only guaranteed
adjacent if you finish one aisle before starting the next** — confirmed as an operational convention
("we will ask them to start from scratch, or only add new aisles to the next section"), not something
the system enforces; building a second flank onto an old aisle much later, after other aisles were
generated in between, will *not* backfill an adjacent number, by design.

**Rack Name format**: `R{flankNumber}-{rack}[-D{depth}]` — e.g. `R1-04` (single-deep), `R1-04-D2`
(the 2nd position in a multi-deep lane). Deliberately excludes Level — a top-down plan can't spatially
show height, so Level stays separate smaller text below the name (unchanged from before), not baked
into the label. `buildCode()` still appends a plain `B` letter for a secondary flank's code (the
*database* code format is untouched — `A01-R05-L02-B1` vs `A01-R05B-L02-B1` exactly as before,
computed from a transient `isSecondaryFlank` boolean rather than the retired `side` field); Rack Name
is a separate, newer, more human-facing label built from `flankNumber` and shown in the Plan View,
not a replacement for the existing `code`.

**Manual create's known gap.** The generator always knows primary vs secondary (whichever range box
you typed into); manual single-record create has no such choice. If an Aisle already has both flanks
established and a manual create doesn't specify one, it defaults to the primary (lower) flank — an
accepted, documented limitation given manual create is already the rare/secondary path (bulk
generation is the primary one for real scale, per existing convention above).

**"Add Location manually" (the blank-create entry point) was removed from the frontend the same
day**, per direct instruction — "let's avoid having add location manually... both do same tasks why
to confuse all." The range generator is now the only way to create a Location; **Edit was
deliberately kept** (a distinct, still-needed maintenance operation, not a duplicate of generation) —
`LocationsPage.tsx`'s form now only ever opens via `startEdit()`, `handleSubmit` always PATCHes, and
`resetForm()` now also closes the form (previously it stayed open for the next manual add, which no
longer applies). The backend's `POST /locations` endpoint itself was left functional/untouched — only
the frontend's blank-create UI entry point was removed.

Verified via a throwaway-company test script (9/9): single-sided allocates flank 1; adding a mirrored
second flank to that same aisle allocates flank 2 (no gap); a *different* aisle's single flank
continues at 3 (no reset); code suffixes match (`B` only on the higher/secondary flank); all codes
stay unique; manual create on an aisle with two established flanks correctly defaults to the primary.
Then re-verified live through the actual browser: confirmed "Add Location manually" is gone from the
UI while every row's "Edit" button still works, and confirmed the Plan View renders `R1-01`..`R1-04`
(primary flank), `R2-01`..`R2-04` (mirrored secondary flank, same rack numbers as primary, different
flank number), and `R3-01-D1`/`D2` through `R3-03-D1`/`D2` (a second aisle's single flank correctly
continuing the sequence at 3, with real per-depth boxes) — Level lines (`L01-L04`, `L01`) and Section
labels (`Section TBR`, `Section TBB`) alongside them, exactly matching the design conversation's own
worked examples. Cleaned up via Delete All afterward.

**Follow-up polish, same day:**
- **`Zone` (the pre-existing free-text field) vs `Section` — not the same concept, even though they
  look identical today.** `zone`'s original schema comment already said "a zone groups aisles" — the
  "Zone" concept discussed as future work (grouping *several* Aisles, e.g. Zone 1 = Aisles 1-4) isn't
  a new field to build, it's exactly what `zone` was already meant for; it just has no consistency
  rule yet (unlike Section). Hierarchy: Zone (coarse, many Aisles) > Section (exactly 1 per Aisle) >
  Aisle. Section was kept, not removed — they serve different granularities.
- **Bin Range hidden by default in the generator**, behind a "+ This rack has multiple bins per
  level (small-parts shelving)" checkbox (`genShowBinRange` in `LocationsPage.tsx`) — it only ever
  applies to shelving, never to pallet racking (the common case), where it just sat unused at its
  default `'1'`. No schema/backend change — purely hides the field and omits it from the generate
  payload unless checked.
- **Level labels switched from `L1`/`L2` to a real building/racking convention** — Level 1 (ground)
  shows as `G`, everything above counts up from there (`G+1`, `G+2`...). A contiguous range starting
  at ground shows only the top (`G+3` for levels 1-4, not "G to G+3" — confirmed explicitly, the
  range is implied). A range that doesn't start at ground (rare) falls back to showing both ends
  (`G+1-G+3`) rather than silently dropping that it's not a from-the-floor stack — an assumption
  flagged, not separately confirmed. `levelLabel`/`levelRangeLabel` in `LocationsPlanView.tsx`.

Verified live through the actual browser: the Bin Range field is hidden until the checkbox is
checked, then appears; three seeded aisles (levels 1-4, level 3 alone, level 1 alone) rendered
`G+3`, `G+2`, and `G` respectively in the Plan View, exactly as specified.

**A second follow-up, same day: a flank-level callout, and a corrected "bins" label.** A Rack box's
third line used to read "N bins" when a top-down box collapsed multiple Levels into one visual
position — technically accurate, but confusing since it reads like the actual `Bin` field. Replaced
with the location's **Category** name instead (more useful at a glance — "what's actually meant to be
stored here"). Each flank also gets a callout above its whole column — `R1`, `R2`... — the same way
the Aisle code sits above the walkway. **This is additive, not a replacement** — every box still
shows its full `R{flank}-{rack}[-D{depth}]` label too (`R1-04`, not just `04`). A first pass wrongly
dropped the per-box prefix on the assumption the callout made it redundant; corrected the same day
once flagged — the callout is for scanning a whole column at a glance, the full per-box label is
still the real identity. Applies to every storage type present (flankNumber is assigned regardless of
Rack/Ground/Stillage), not rack-only — worth another look once Ground gets its own naming treatment,
in case it should read differently there. Verified live (twice — once for the mistaken version, once
after the fix): seeded a mirrored aisle with 4 levels and a Category set — confirmed `R1`/`R2`
callouts render above the correct columns, every box shows its full `R1-01`/`R2-02`-style label (not
just the bare number), no "bins" text appears anywhere, and the Category name shows in every box.

### Yard & Gate Management (2026-08-25)
First slice of the next pipeline stage (Master Data → **Yard & Gate** → Inbound). Scope that ended
up covered in this pass, confirmed with the client across several rounds of conversation: **Dock
Door Management**, **Gate In/Out** (including E-Way Bill and inbound material confirmation), a
lightweight **Yard Management** (real numbered parking slots), and **Gate Pass Number** sequencing —
**Weight Bridge Integration was explicitly dropped** (2026-08-25) — most Indian warehouses don't
have one; noted as a low-priority deferred topic, not a rejected one, revisit if it comes up later.
The minimal `grossWeightKg`/`tareWeightKg` fields already on `VehicleGateEntry` were left in place
(harmless, optional, already built) rather than ripped back out. **Dock Scheduling** (advance
appointment booking) is the only piece with no schema at all yet — confirmed as a logic-and-schema
task for a future session, not something needing further design conversation right now. This
module started with a real process misstep worth remembering: an early pass jumped straight from a
single scoping question to designing and building a full backend module (services, role rules,
dock-assignment conflict logic) without actually discussing the real gate workflow first — caught
and reverted in conversation, not left in place. See `[[wms-align-before-coding]]` in memory.
E-Way Bill and inbound-material-confirmation enforcement at Gate Out (below) is real, working logic
— built and verified in an earlier round of this same pass. **Yard Slot auto-assignment/release and
Gate Pass Number generation are schema-only** — the `yardSlotId`/`gatePassNo` fields exist and sit
unused by `GateEntriesService` for now; the client explicitly asked to finish all schema for this
topic first and pick up that logic (plus Vehicle/Driver registration, blacklist checks, and any
frontend) in a later pass. **No frontend exists yet for any of this.**

**`VehicleType`** — platform-level reference data, same shape as `ProductCategory` (no `companyId`,
not client-editable via any UI, since `SUPER_ADMIN` account creation still doesn't exist — seeded
directly into the DB via `prisma/seed.ts`). 18 rows covering Indian mini-truck-through-40ft-container
segments, built with the client through a real back-and-forth (a vehicle-type list, then corrected
for a units-basis mixup — gross weight vs. payload aren't comparable — then split where two named
vehicles turned out to have meaningfully different specs: Dost vs. Bada Dost, Eicher 14ft vs. 17ft).
Two/three-wheelers and non-standard bodies (Low-Bed Trailer, Flatbed, Curtain-Sided, a generic
Multi-Axle open truck) were deliberately dropped — no reliably sourced dimension was found for them.
Dimensions are three separate numeric columns (`lengthFt`/`widthFt`/`heightFt`), not a combined
label — same "one field per dimension" convention as `WarehouseStorageType`'s `lengthM/widthM/
heightM` — specifically so a future feature can do real truck-load/volume math. `maxTonnage` is one
number (a payload ceiling), not a min/max range, so it can be compared directly against a future
weighbridge reading. **The `20 ft Open Body Truck`/`20 ft Closed Container` tonnage (7 Ton) is a
placeholder pending the client's own fleet check** — flagged explicitly, don't treat it as final.

**`DockDoor`** — dock door master data (warehouse, code, name, type IN/OUT/BOTH, a plain
`status` field). **Deliberately NOT linked to `VehicleGateEntry`** — an earlier draft gave
`VehicleGateEntry` an optional `dockDoorId` with the system auto-flipping the door's status to
OCCUPIED/AVAILABLE as a side-effect of gate-in/out. Rejected by the client: Dock Door status is a
manual, staff-driven action in India in practice, and real dock *selection* logic (which vehicle
gets which door, and when) needs its own design pass later, not a side-effect of the gate log — the
FK/column was removed from the schema entirely, not just the auto-flip behavior. `DockDoorsService`
still has a manual `PATCH /:id/status` endpoint for staff to toggle it directly.

**`Vehicle`** and **`Driver`** — company-scoped master data, "register once, reuse" (2026-08-25,
during the document-check conversation): a recurring vehicle/driver shouldn't need its documents
re-typed at every gate entry. **Registration is a separate, deliberate step — Gate In always picks
an EXISTING Vehicle/Driver, never creates one inline** (an auto-create-on-unrecognized-number idea
was explicitly rejected). `Vehicle` carries `vehicleTypeId` (fixed — a truck doesn't change class
trip to trip) plus **optional actual measured `lengthFt`/`widthFt`/`heightFt`** that override
`VehicleType`'s generic segment dimensions when known (falls back to the generic default when not
measured) — a deliberate refinement so real per-truck data beats a generic segment average once
available. `Vehicle` also carries `rcNumber`/`rcExpiry`, `insuranceNumber`/`insuranceExpiry`,
`pucNumber`/`pucExpiry`, `fitnessNumber`/`fitnessExpiry`. `Driver` is separate from `Vehicle` (not
folded into it) specifically because a Driving License belongs to the *person*, not the truck — the
same vehicle can show up with a different driver trip to trip. No unique constraint on `Driver`'s
`phone`/`licenseNumber` (neither is a reliable-enough natural key to hard-enforce yet — an operator
searches/selects manually); `Vehicle.vehicleNumber` does get `@@unique([companyId, vehicleNumber])`,
a genuinely reliable natural key. **No management UI exists yet for either** — that's next. Both also
carry a simple **`isBlacklisted`/`blacklistReason`** pair (confirmed needed for both, 2026-08-25) —
same plain flag-plus-reason shape as everywhere else in this codebase (no who/when audit trail),
though **nothing currently checks this flag at Gate In** — that enforcement is still unbuilt.

**`GateEntryDocumentCheck`** — child table (a gate entry can check several documents:
License/Insurance/RC/PUC/Fitness), one row per document type per entry, `status` OK/FLAGGED/MISSING
plus an optional note — same "more than one of, make it a child table" principle as
`SkuBarcode`/`CustomerShipTo`. The document's actual number/expiry lives on `Vehicle`/`Driver`; this
table only records the pass/fail judgment call made fresh at *this* visit.

**`VehicleGateEntry`** — the confirmed real workflow (2026-08-25 conversation): vehicle arrives →
driver informs security → security selects the registered Vehicle + Driver, logs the transporter
(free text — can vary trip to trip even for the same vehicle/driver, so it's not on either master),
and checks key documents → loading happens → for **Outbound Dispatch**, an E-Way Bill is generated
and its number captured at Gate Out; for **Inbound Delivery**, Gate Out instead requires a manual
"all material received/scanned" confirmation (a placeholder — Inbound/Receiving doesn't exist yet to
drive this automatically) → only once that purpose-specific condition is met does `gateOut()` allow
closing. The E-Way Bill requirement is gated by a new **`Company.requireEwayBillForOutboundGateOut`**
boolean (default `false`) — not every client routes E-Way Bill data through this system, some handle
it entirely in their own ERP, so it's an explicit per-company opt-in, not a hardcoded rule.
**Destination was raised, then explicitly scrapped for this pass** — multi-point delivery (a single
outbound trip serving several customer drop points) would need real modeling (a child table, not a
single FK) that wasn't worth building without a confirmed real need; intra-company warehouse-to-
warehouse transfer was the only single-point case, and even that was deprioritized alongside it.
Revisit if/when it's actually needed. **`VEHICLE_ONLY` (a non-cargo-visit purpose) was proposed,
then dropped** the same day — no concrete real use case for it, and the client wasn't sure what it
would even mean in practice; `GateEntryPurpose` is `INBOUND_DELIVERY`/`OUTBOUND_DISPATCH`/`RETURNS`
only. Dropping a Postgres enum value needs a swap-in-a-new-type migration (`ALTER TYPE ... DROP
VALUE` isn't supported) — see the `20260825230000_yard_slots_gate_pass_and_blacklist` migration for
the pattern if another enum value needs removing later.

**Yard Management** — a deliberately lightweight slice, not the full parking-bay system originally
sketched. `Warehouse.yardCapacity` (Int, only settable at creation — same limitation as the Warehouse
Manager fields, until Warehouse Edit exists) is meant to drive generating that many real, numbered
`YardSlot` rows (`Y1`, `Y2`...) — **the generation logic itself is not built yet**, only the schema.
`VehicleGateEntry.yardSlotId` is meant to be auto-assigned from the free pool at Gate In (never
picked manually) and released — **not at Gate Out**, but when the vehicle actually moves to a dock,
per the client's explicit correction ("it will be linked when we develop that"). Since Dock
Scheduling/assignment doesn't exist yet to drive that release, **the intended interim behavior is to
release on Gate Out as a placeholder** — re-wire this the moment dock-in tracking exists; this is
not yet implemented at all (schema-only, per the client's own request to finish schema before logic).
`Company.blockGateInWhenYardFull` (default `false`) controls whether a full yard hard-blocks a new
Gate In or just warns — **both modes are wanted, toggle per company; a "yard full" warning must
always surface regardless of which mode is active** — none of this check is implemented yet either.

**Gate Pass Number** — the human-facing sequential number a driver would be handed, tracked via
`GatePassSequence` (one counter per warehouse **and** per direction — Inbound and Outbound never
share a sequence; Returns counts as Inbound, confirmed) with a `periodKey` whose shape depends on
`Company.gatePassResetPeriod` (`FINANCIAL_YEAR`/`QUARTER`/`MONTH`, configurable per company,
default `FINANCIAL_YEAR`) — **`QUARTER` means financial-year quarters** (Apr–Jun/Jul–Sep/Oct–
Dec/Jan–Mar), not calendar quarters, confirmed explicitly since it's easy to get backwards.
`VehicleGateEntry.gatePassNo` is where the generated number would land. **None of the actual
generation/incrementing logic is built yet** — schema only. A future "count of vehicles by
VehicleType" analysis (raised in the same conversation) needs no new schema at all — it's already
derivable from `VehicleGateEntry → Vehicle → VehicleType` once a reporting screen exists.

Verified so far: all three migrations in this pass applied cleanly against the real dev DB (including
a Postgres enum-value drop and a 24-row `Company` backfill via column defaults, both with no issue),
Prisma client regenerated, `tsc --noEmit` and a full clean backend restart both came back with zero
errors and a single listening process (`curl` → 200), and direct queries confirmed every new
table/column (`Vehicle`, `Driver`, `GateEntryDocumentCheck`, `YardSlot`, `GatePassSequence`, the new
`Company` toggles) is queryable with the expected defaults. **Not yet done**: no throwaway-company
end-to-end test script, no live browser check (nothing exists in the frontend to check yet), no
Vehicle/Driver registration UI, no yard-slot/gate-pass-number business logic, no blacklist
enforcement at Gate In, and Dock Door's own workflow logic (beyond the plain manual status toggle) is
still unbuilt, no schema at all yet for **Dock Scheduling** (the one piece with no design work done),
and **Weight Bridge Integration is dropped/deferred** (low priority, not rejected outright — see
above).

Nothing else remains an open *decision* for this topic as of 2026-08-25 — every remaining item above
is build work (logic + frontend) explicitly saved for a future session, not something still waiting
on the client.

### Yard Management — real logic built and verified (2026-08-26)
Follow-up session, backend logic only (no frontend yet). Merged to `main` after the schema-only pass
above. A real process note first: this pass started with the client explicitly asking not to be
re-asked about things already flagged as placeholder/deferred (Dock Scheduling in particular) —
"use dummy APIs... dock selection and scheduling will be done, DON'T WORRY." The calibration from
`[[wms-align-before-coding]]` (discuss real workflow decisions before building) still applies to
*new* decisions; it doesn't mean re-litigating something already agreed to be a placeholder. Four
real decisions got made this pass, then built end-to-end:

1. **`Warehouse.yardCapacity` is now fully wired** — manual create form (`WarehousesPage.tsx`),
   Excel import/export (both `templates/` and `frontend/public/templates/` copies of
   `Warehouse_Master_Import_Template.xlsx` got a new "Parking Slots" column + Legend & Rules entry),
   and `WarehousesService.create()`/`bulkImport()` both call a new `generateYardSlots()` that creates
   `Y1..YN` `YardSlot` rows right away. Only settable at creation (no Warehouse Edit yet, same
   limitation as everywhere else this has come up).
2. **The yard-slot lifecycle is real, working logic**, not schema-only anymore:
   `GateEntriesService.create()` auto-assigns the next `AVAILABLE` slot (any slot — which one
   genuinely doesn't matter, confirmed) via `assignYardSlot()`. A warehouse with **zero** slots (no
   `yardCapacity` set) is a clean no-op — no warning, no block, Gate In/Out proceeds exactly as
   normal; Yard Management simply doesn't apply to it (confirmed explicitly). A warehouse **with**
   slots that's completely full always returns `yardFullWarning: true` on the response; whether that
   also **blocks** the Gate In depends on the new `Company.blockGateInWhenYardFull` toggle (default
   off) — both modes were explicitly wanted, warning always shows regardless of which mode.
3. **`dockedInAt`/`dockedInById` is a deliberately lightweight stand-in for real Dock Scheduling** —
   just marks "this vehicle left the yard" and frees its slot (`GateEntriesService.dockIn()`, `PATCH
   /gate-entries/:id/dock-in`). No dock door selection, no appointment logic — that's a real future
   feature, this is intentionally a dummy trigger per the client's own framing. **`gateOut()` also has
   a safety-net slot release** for a vehicle that never got marked docked-in (loaded/unloaded straight
   from the yard, or the step just got skipped) — otherwise that slot would leak as permanently
   occupied forever.
4. **Elapsed yard time is never stored, anywhere** — confirmed with the client directly (they asked
   which was more efficient) — it's `dockedInAt - gateInAt` for a finished stay or `NOW - gateInAt`
   for an ongoing one, computed at read time in `YardService.parked()` from timestamps that already
   exist. No new column, no separate table, no drift risk.
5. **`destinationCity`** — a deliberately simple single-city text field, reintroduced after the
   original multi-point/Customer-Ship-to "Destination" was scrapped as overkill. No FK, no multi-drop
   modeling.

**New `YardService`/`YardController`** (`GET /yard/summary`, `GET /yard/parked`) — a read-only
reporting layer over data `GateEntriesService` already owns, not a third place that mutates
`YardSlot`/`VehicleGateEntry`. `summary()` returns per-warehouse total/occupied/available plus a
`yardConfigured` flag (false for a zero-slot warehouse, so the frontend can show a clean "not
configured" state instead of empty stat boxes). `parked()` is the "working table" — currently-parked
vehicles with slot code, vehicle number, destination city, transporter, gate-in time, and computed
`elapsedHours`.

Verified via a throwaway-company end-to-end test script, 30/30 checks passing: warehouse creation
with `yardCapacity` generating the right slot count (and zero slots for a warehouse with none set),
negative `yardCapacity` rejected, two vehicles gating in and correctly consuming both slots, the
summary reflecting occupied/available accurately (including the zero-slot warehouse's
`yardConfigured: false`), a third vehicle gating in successfully with `yardFullWarning: true` and no
slot while the block toggle was off, a fourth vehicle correctly BLOCKED once the toggle was flipped
on, the parked list showing both waiting vehicles with a computed `elapsedHours`, Dock In correctly
freeing a slot and the summary updating live, and Gate Out's safety net correctly freeing a slot for
a vehicle that skipped Dock In entirely. Cleaned up afterward (two throwaway companies, since an
early test-script bug — a missing required `name` field on Warehouse create, not a real bug —
produced an extra one; both were found and removed, confirmed against a stray-looking "WH1" warehouse
match that turned out to belong to genuine pre-existing throwaway companies from earlier sessions,
left untouched).

**Still not built**: any frontend for Yard Management or Gate In/Out, blacklist enforcement at Gate
In, Gate Pass Number generation, and Dock Scheduling itself.

### Vehicle/Driver registration — full CRUD + frontend (2026-08-26)
Follow-up to the pass above, filling the gap it flagged. New top-level `VehiclesModule`/
`DriversModule` (`backend/src/vehicles/`, `backend/src/drivers/` — sibling modules to `warehouses/`
etc., not nested under `yard-gate/`, since these are genuinely master data like Customer, just with
Yard & Gate's operational role gating rather than `MASTER_DATA_*` roles) give both entities the full
standard shape: create/list/update/deactivate/reactivate/`Delete All`/single delete, following
`DockDoorsService`'s exact pattern. Also added `VehicleTypesModule` (`GET /vehicle-types`, read-only,
same shape as `ProductCategoriesController`) — needed so the frontend has something to populate the
Vehicle Type dropdown from; `VehicleType` itself was seeded weeks ago but never had a list endpoint.

**Role gating**: `GATE_YARD_OPERATE_ROLES` (Operator included) can register/edit — this is closer to
Gate Entry's own access shape than to Warehouse/Customer's `MASTER_DATA_WRITE_ROLES`, since the same
gate/security staff who log a vehicle in are exactly who'd register a new one showing up for the
first time. Delete stays `COMPANY_ADMIN`-only per the established convention. Both are company-scoped
only (`companyFilter`, no `ownWarehouseIds` restriction) — a vehicle isn't tied to one warehouse.

**Validation notes**: `Vehicle.vehicleNumber` is uppercased and checked unique per company (a real
natural key); blacklisting either entity requires a `blacklistReason` (enforced by the API returning
400, not just a UI nicety). `Driver` has no uniqueness check on phone/license, matching the schema
comment's reasoning (neither is reliable enough to hard-enforce).

**Frontend**: `VehiclesPage.tsx`/`DriversPage.tsx`, added as new "Vehicles"/"Drivers" tabs in
`App.tsx` (visible to every logged-in role, not gated behind `CAN_MANAGE_USERS` — matches the backend
role shape). Both follow the standing list-page template from
`[[wms-frontend-styling-conventions]]` (centred table, centred stat-box row, flat unboxed button row,
collapsible list with search) with one deliberate deviation: **no bulk Excel import/export for
either** — scope was kept to manual register/edit for this pass; flagged as a possible follow-up, not
forgotten. `VehiclesPage`'s form combines both entities' data sources — the Vehicle Type dropdown is
populated from the new `GET /vehicle-types` endpoint, showing each option's segment and max tonnage
inline so the picker is self-explanatory without a separate lookup.

Verified two ways: a throwaway-company API test script (18/18 checks — create, vehicle-number
uppercasing, duplicate rejection, missing-Vehicle-Type rejection, blacklist-without-reason rejection,
update, deactivate/reactivate, delete blocked once a Gate Entry links to it, `Delete All` correctly
reporting 1 blocked/0 deleted), and a live browser pass through the actual rendered UI (logged in via
the API+localStorage token trick, not the login form) — registered one real Vehicle and one real
Driver by actually filling and submitting the real forms, confirmed both stat boxes and table rows
updated correctly. Both throwaway companies cleaned up afterward.

### Gate In/Out screen build, backend half (2026-08-27)
Design conversation before this pass settled: one combined page for both Gate In and Gate Out (not
built yet — frontend is next); a new `SECURITY_SUPERVISOR` role restricting who can access it;
Vehicle/Driver registration moving onto that same page as two buttons, replacing the standalone
`Vehicles`/`Drivers` nav tabs entirely (not built yet either); and an Outbound overweight check
against the invoice. This section covers what's actually built and verified — the backend half.

**`SECURITY_SUPERVISOR`** — a genuinely new `Role` enum value, confirmed explicitly as sitting at the
**same hierarchy level as `WAREHOUSE_SUPERVISOR`** (a peer, not a sub-role), just with a different
access surface (gate/yard duty instead of general warehouse oversight). Postgres can't remove an enum
value without the swap-a-new-type dance (see the Yard & Gate schema section above), but CAN add one
directly via `ALTER TYPE ... ADD VALUE` as long as the new value isn't used in the same migration —
confirmed working here. Ripple effects handled:
- `CREATABLE_ROLES` (`users.service.ts`, mirrored client-side in `UsersPage.tsx`): `WAREHOUSE_MANAGER`
  can create both Supervisor peers; neither peer can create the other (only `COMPANY_ADMIN` creates
  peers of itself); both can create `OPERATOR`.
- Excluded from `MASTER_DATA_READ_ROLES` — same "zero visibility, surface is a task screen" reasoning
  as `OPERATOR`, just for gate/yard duty. **Except Users itself** — `UsersController`'s
  `CAN_MANAGE_USERS` (and its `App.tsx` mirror) explicitly add `SECURITY_SUPERVISOR` back in, since
  `CREATABLE_ROLES` lets it manage `OPERATOR` accounts under it; this was a real gap caught by the
  verification script (a 403 at the controller layer even though the service logic was already
  correct) before being fixed. `WAREHOUSE_SCOPED_ROLES` also gained `SECURITY_SUPERVISOR` for the same
  reason (their Users-page visibility needs to be warehouse-scoped) — harmless for the other three
  master-data services, which never reach that scoping check for this role anyway (blocked earlier by
  their own controllers' `MASTER_DATA_READ_ROLES` gate).
- `GATE_YARD_READ_ROLES`/`GATE_YARD_OPERATE_ROLES`/`GATE_YARD_SCOPED_ROLES` all include it — this is
  the role the whole page exists for.
- ID-based login (not in `EMAIL_REQUIRED_ROLES`), same as Supervisor/Operator.

**`Company.restrictGateAccessToSecuritySupervisor`** (default `false`) — the "easily removable" part.
When on, `SECURITY_SUPERVISOR` and above (`WAREHOUSE_MANAGER`/`COMPANY_ADMIN`/`SUPER_ADMIN`) keep Gate
In/Out access; `WAREHOUSE_SUPERVISOR`/`OPERATOR` lose it. Defaults off (today's broad access
unchanged) since no company has any `SECURITY_SUPERVISOR` accounts the moment this ships — turning it
on is a deliberate per-company opt-in once those accounts exist, not a day-one default that would
otherwise lock every existing company out of a page that already works. Enforced by a new
`assertGateAccessAllowed()` helper in `tenant.util.ts`, called at the top of every public method on
`GateEntriesService`, `YardService`, `VehiclesService`, and `DriversService` — all four now live only
on the Gate page, so all four respect the same toggle (not just a static `@Roles()` decorator, since
this needs a live per-company DB read, not a fixed role list).

**Overweight check (Outbound Dispatch only, unconditional — the client's own KPI, not a toggle like
E-Way Bill)**: `Vehicle.maxTonnage` — a new per-vehicle override, same "override when known, fall back
to `VehicleType`'s generic ceiling otherwise" pattern already used for the dimension fields.
`VehicleGateEntry.invoiceWeightKg` — a manual placeholder for now (required to close Outbound Gate
Out), standing in for the real total the client described: `SUM(SKU weight × quantity in invoice)`.
**No further schema was needed for that real computation** — `Sku.grossWeight`/`weightUom` and
`OutboundOrderLine.orderedQty` already exist from the original schema design, so once a real
Outbound/Invoice module gets built, wiring in the actual computed total is a service-layer change
only. `gateOut()` compares `invoiceWeightKg` against `(vehicle.maxTonnage ?? vehicleType.maxTonnage) *
1000` — over that ceiling throws a `BadRequestException` naming the vehicle and both numbers; Gate Out
is hard-blocked, not just flagged.

**`YardService.parked()` renamed to `tracker()`** (`GET /yard/tracker`, was `/yard/parked`) — now
covers docked-but-not-yet-gated-out vehicles too, not just ones still waiting in the yard, per the
client's request for both "hours in parking" and "hours in dock" columns on the working table. Both
are computed at read time, never stored: `hoursInParking` is `gateInAt -> dockedInAt` (fixed, once
docked) or `gateInAt -> NOW` (still climbing, while waiting); `hoursInDock` is `null` until
`dockedInAt` is set, then `dockedInAt -> NOW` (the row disappears from the table entirely once Gate
Out closes it, so this only ever measures an open dock stay). A `status` field (`IN_YARD`/`DOCKED`)
is included as a convenience so the frontend doesn't have to infer it from `dockedInAt` itself.

Verified via a throwaway-company test script, 21/21 checks passing (after catching and fixing the
`CAN_MANAGE_USERS` gap above): the full role hierarchy (Manager creates both Supervisor peers,
neither peer creates the other, both create Operator), the toggle's exact before/after behavior for
all four roles, the overweight block at exactly the registered ceiling, a missing-invoice-weight
block, a successful under-ceiling Gate Out, and the tracker's `status`/`hoursInDock` flipping
correctly after Dock In. Cleaned up afterward. **Not yet built**: the actual Gate In/Out frontend
page, the two Vehicle/Driver quick-registration buttons (and removing the standalone nav tabs to
match), and the document-check auto-pull-and-confirm UI.

### Gate In/Out screen build, frontend half (2026-08-27)
Completes the pass above. One new page, `GateYardPage.tsx`, replaces the standalone `Vehicles`/
`Drivers` tabs entirely (both files deleted) — the client's explicit call: Yard Management and Gate
In/Out share one page ("security should have visibility together"), and Vehicle/Driver registration
moved onto it as two buttons ("Register Vehicle"/"Register Driver") opening modals, not separate
pages. Wired into `App.tsx` as a single "Gate & Yard" tab, visible to every logged-in role like the
other master-data tabs (no client-side role hiding — the backend's `assertGateAccessAllowed`/
`@Roles()` gates are the real enforcement).

**Page layout, top to bottom**: title → button row (+ Gate In / Register Vehicle / Register Driver)
→ Yard Status stat boxes (one per warehouse — real Total/Occupied/Available for a `yardConfigured`
one, a plain "No parking configured" line otherwise) → **Currently Open** collapsible section (the
working table, defaults expanded) → **List of All Gate Entries** collapsible section (history,
defaults collapsed, with a text search, a From/To date filter, and an Export button). This deviates
from the standard 5-master-data-page template in `[[wms-frontend-styling-conventions]]` on purpose —
a transaction log doesn't have an Active/Inactive-style default state, so stat boxes came from the
Yard summary instead, and there are two collapsible sections (open vs. history) rather than one list.

**Gate In form**: Warehouse defaults to the user's only entry when `GET /warehouses` (already
tenant/warehouse-scoped server-side) returns exactly one. Vehicle/Driver pickers are plain `<input
list>` + `<datalist>` — a native HTML searchable-dropdown, no extra library — matching text against
`vehicleNumber` / `"name (phone)"` to resolve the real id; no exact match leaves the id unresolved
(caught server-side as "Vehicle is required" if submitted anyway) rather than silently guessing. The
document-check table appears once a Vehicle or Driver is selected, pulling each of the 5 documents'
number+expiry live from the record (`RC`/`Insurance`/`PUC`/`Fitness` from Vehicle, `License` from
Driver) with an expired date shown in red — exactly the "the security needs to get that info" ask.
Each row is a single "Confirmed OK" checkbox (unticked → `MISSING`), not a 3-way selector, per the
client's direct confirmation. Blacklisted Vehicle/Driver shows an inline warning (not a hard block —
that wasn't asked for). The yard-full banner is inline on the form, computed reactively from the
already-loaded `/yard/summary` the moment a warehouse is picked — not a popup after submit.

**Gate Out modal**: fields shown depend on the entry's `purpose` — Tare Weight always; Invoice
Weight (required) + E-Way Bill No for Outbound; a "material received" checkbox for Inbound. Any
backend validation error (overweight, missing E-Way Bill, missing confirmation) surfaces inline in
the modal, not a toast — same "show it where the mistake was made" idea as every other form in this
codebase.

**Register Vehicle/Driver modals** reuse the exact form fields the old standalone pages had (nothing
lost in the move) — on success they close, reload their list, and (2026-08-27 convenience) auto-fill
the newly-registered record straight into whatever Gate In form is open, so a guard who hits "not
found" while typing doesn't lose their place.

Verified live through the actual rendered UI (logged in via the API+localStorage token trick): `tsc
-b` and a full `vite build` both came back clean; registered one real Vehicle (with a `maxTonnage`
override) and one real Driver through the real modals, confirmed via a direct API check the vehicle
saved correctly; ran a complete Gate In (warehouse auto-selected, vehicle/driver resolved via the
datalist pickers, document table correctly showed the driver's license and "Not on file" for the
vehicle's unset documents) and watched the yard stat boxes and working table update live (slot `Y1`
assigned, 3→1 occupied); clicked "Mark Docked In" and watched the row flip to `Docked` with
`hoursInDock` starting to count and the slot free again (3→0 occupied); opened Gate Out and confirmed
the exact overweight block message (`1500 kg exceeds ... 1200 kg`) rendering inline, then completed a
real Gate Out with a valid weight and watched the row disappear from the open table and land
correctly in history as `Gated Out`; confirmed `GET /gate-entries/export` returns a real non-empty
`.xlsx`. Throwaway company cleaned up afterward.

**Still not built**: Gate Pass Number (no UI needed yet, since the generation logic itself doesn't
exist), blacklist *enforcement* (the warning shown is informational only, doesn't block Gate In), and
Dock Scheduling / Weight Bridge, same as noted throughout this whole topic.

### Gate & Yard live-testing fixes (2026-08-27, same day)
The client tested the built page against a real use case and found three things:

1. **Vehicle registration modal's document dates were unclear** — RC/Insurance and PUC/Fitness were
   packed two-per-row (Number, Date, Number, Date), and a bare `<input type="date">` shows no label
   of its own, so it wasn't obvious which date belonged to which document. Fixed: each document
   (RC/Insurance/PUC/Fitness) now gets its own labeled row (`GateYardPage.tsx`'s Register Vehicle
   modal) with an explicit "Expiry" label next to its date field; the Driver modal's single License
   Expiry field got the same label added for consistency even though it wasn't ambiguous on its own.
2. **No way to blacklist an already-registered Vehicle/Driver** — removing the standalone `Vehicles`/
   `Drivers` pages (per the client's own "remove and add buttons" instruction) also removed the only
   edit path, and the two new "Register" modals only ever create, never edit. **Flagged, not fixed —
   the client explicitly said they want to think about the right shape first** (a dedicated edit
   page? inline edit from a list? a blacklist-only quick-toggle view?) before anything gets built.
   Don't assume a solution here without checking back.
3. **Real cross-warehouse visibility bug, caught by the client's own use-case test**:
   `YardService.tracker()`'s `?warehouseId=` query param let a warehouse-scoped role (Supervisor,
   Security Supervisor, Operator, Manager) bypass their own `ownWarehouseIds()` restriction entirely
   by just passing a different warehouse's id — confirmed and reproduced via a throwaway two-warehouse
   test before fixing. Fixed: an explicit `warehouseId` is now checked against the caller's own
   accessible set first (`ForbiddenException` if outside it) rather than blindly overriding the scope
   filter. `GateEntriesService.findAll()`/`YardService.summary()` were already safe (neither accepts
   a client-supplied warehouse override) — this was specifically a `tracker()` bug. Verified via a
   throwaway two-warehouse test, 12/12 checks passing (a Supervisor scoped to WH1 sees only WH1 across
   `/warehouses`, `/yard/summary`, `/yard/tracker`, `/gate-entries`, and `/gate-entries/export`, is
   rejected with 403 when forcing `?warehouseId=<WH2>`, while an unscoped Admin can still legitimately
   use that same param to filter between warehouses they do have access to).

### Vehicle & Driver Master page (2026-08-27)
Follow-up to the "no way to edit/blacklist" gap flagged in the live-testing pass above. The client
was explicit they wanted to think about the shape before anything got built — this is what they
landed on, confirmed in conversation before coding:

**A new standalone "Vehicle & Driver Master" tab, next to Gate & Yard in the nav** — one page, two
separate tables (Vehicles, Drivers), not merged into one. **No create button on this page** —
registration stays exactly where it already was, the "Register Vehicle"/"Register Driver" buttons
on `GateYardPage.tsx`; this page exists purely to browse/search/edit/blacklist/deactivate/delete
what's already on file, populated continuously as gate staff register vehicles and drivers. Editing
opens a **normal on-page form, not a modal** — same "form doubles as edit form" pattern
`LocationsPage.tsx` already uses (`editingVehicleId`/`editingDriverId` state, `startEdit` pre-fills,
`handleSubmit` always PATCHes since there's no create path on this page). Blacklist
(`isBlacklisted`/`blacklistReason`) is just two fields inside that same edit form — no separate
blacklist-only view, per the client's own call ("blacklist in the page we are making"). **Export
only, no bulk import** — confirmed explicitly ("it has to be manual add, will be one time for every
driver/vehicle"), unlike every other master-data entity.

New `frontend/src/VehicleDriverPage.tsx`, wired into `App.tsx` as a `vehicledriver` tab. Backend
reused the existing Vehicle/Driver CRUD (update/deactivate/reactivate/delete/Delete All) built in
the 2026-08-26 pass wholesale — the only new backend work was `GET /vehicles/export` and
`GET /drivers/export` (`exportRows()` on each service, same `json_to_sheet` shape as every other
export endpoint, gated `GATE_YARD_READ_ROLES` matching `findAll`'s own gate).

Verified: `tsc --noEmit` (backend) and `tsc -b` (frontend) both clean, and the client confirmed it
working live in their own browser session. **Not independently re-verified via a throwaway-company
script or a live browser pass from this session** — the dev server was owned by a different session
at the time, so this pass relied on the client's own check rather than the usual two-part
verification. Worth a proper throwaway-company pass (Edit/blacklist round-trip, Export producing a
real non-empty file, role gating) the next time this area is touched, rather than assuming it's
fully proven.

### Yard Management: candidate next features, researched not built (2026-08-27)
A web-research pass (not a design conversation yet) surveyed what typical Yard Management Systems
include, to sanity-check what this module might still be missing. Findings, for reference — **none
of this is built, and most of it isn't even schema'd yet**:

- **ASN (Advance Shipment Notice)** — real finding: `InboundReceipt.referenceNo`'s existing comment
  already says "e.g. supplier ASN / PO number," meaning ASN was always meant to live in the
  (unbuilt) Inbound module, not Yard/Gate. `InboundReceipt`/`InboundReceiptLine` have the SKU/qty
  shape already but no pre-arrival timing fields (expected date/time, expected vehicle/transporter)
  and no FK from `VehicleGateEntry` back to a receipt — both needed before Gate In could match an
  arriving truck against a pre-created ASN. **Open question for the client to resolve first**:
  ASN entered manually by warehouse staff ahead of arrival, or received electronically from a
  supplier (EDI/API) — a real scope fork, the latter overlapping with the WMS/TMS integration item
  below.
- **Detention/demurrage alerting** — cheap: `hoursInParking`/`hoursInDock` are already computed at
  read time in `YardService.tracker()`, nothing new to store there except a per-company threshold
  (open question: one combined threshold, or separate yard-wait vs dock-wait thresholds). "Alert"
  itself is cheapest as a visual flag on the tracker row — an actual push/SMS/email alert needs
  notification infrastructure this project doesn't have at all yet.
- **Blacklist enforcement at Gate In** (hard block, not just the current warning) — explicitly
  parked by the client for a later conversation.
- **Analytics dashboard** (turnaround/dwell trends, dock utilization) — explicitly parked; no schema
  gap, everything it would report on already exists as raw gate-entry/yard-slot data.
- **Self-service driver check-in** (kiosk/QR/app) — client confirmed wanting this eventually, but
  flagged here as needing its **own** align-before-coding pass before any schema: drivers have no
  login/User account in this system at all today, so this is a real new-workflow design question
  (QR-linked no-login form? physical kiosk? what can a driver self-report vs what stays
  security-verified?), not a field-adding one.
- **WMS/TMS integration** — client wants to study this themselves first; deliberately not scoped.
  Worth knowing when they get there: `erpCode` fields on Sku/Warehouse/Customer already establish
  a "landing spot field, no real wiring yet" convention this would likely extend.

Client's direction after seeing this list: build all six eventually, starting with ASN and
detention alerting; explicitly wants schema-now/logic-later separated for each rather than
building either in one shot. Two open questions above (ASN sourcing, detention threshold shape)
block writing schema for either — resolve those before touching `schema.prisma`.

### Detention, multi-channel notifications, and self-service check-in — schema only (2026-08-27)
Follow-up conversation resolved the open questions above and added one new requirement, then this
pass wrote the schema for all three (no service/controller logic yet — deliberately, per the
schema-now/logic-later split the client asked for). **ASN itself stays deferred until Inbound
starts**, per the client's own call — nothing built for it this pass.

**Detention** — `VehicleType.detentionCostPerDay` (generic ₹/24hr rate) + `Vehicle.
detentionCostPerDay` (optional per-vehicle override), the same override-when-known/fall-back-to-
VehicleType pattern already used for `maxTonnage`/dimensions. **Cost accrues from Gate In with no
grace period** — the client's own call ("easier for us to code") — always computed live as
elapsed dwell time × rate, never stored, same "always derive" philosophy as on-hand stock/
capacity. `Company.detentionAlertHours`/`detentionEscalationHours` are a **separate** concept from
the cost calc — purely about *when* to notify someone (an alert at N hours, escalation to the
Company Admin if still unacknowledged M hours after that), not about whether cost applies; without
this split every vehicle would trigger an alert the instant it gates in, since cost itself now has
no grace period.

**Multi-channel notifications** — the client explicitly wants real capacity for SMS, Email, *and*
WhatsApp depending on what a given client company wants ("we need to have capacity to do all...
depending on the client requirement"), not one hardcoded channel — willing to invest real build
time in this rather than a minimal placeholder. Web research (2026-08-27) found WhatsApp Business
API is often cheaper than SMS in India and has meaningfully better real-world read rates for
operational staff; **MSG91** stood out as a good India-first fit (INR billing, GST invoices, one
platform covering SMS+WhatsApp+Email). Two real-world catches to remember when this gets wired up
for real: WhatsApp business-initiated messages need a **pre-approved message template** (no
freeform text), and SMS in India needs **DLT registration** (a telecom-regulator process, takes
real days) — neither blocks schema, both block actually sending anything.

Schema: `CompanyNotificationChannel` (child table — a company can enable more than one channel at
once, same "more than one of, make it a child table" rule as `SkuBarcode`/`CustomerShipTo` — per-
channel `isEnabled`/`senderId`/`fromAddress`/`providerName`); `NotificationLog` (the audit/
delivery/escalation trail — `referenceType`/`referenceId` free-text pointer, same pattern as
`StockMovement.referenceType`, since event types are meant to grow beyond gate-entry-linked ones
later). `NotificationEventType` starts with just `DETENTION_ALERT`, extends the same way
`SECURITY_SUPERVISOR` was added to `Role` (`ALTER TYPE ... ADD VALUE`) as more get built.
**Deliberately NOT in the schema**: any actual provider API key/secret — those stay in environment
config (same place `JWT_SECRET` lives), not the database, until this gets real encryption-at-rest;
storing them in `CompanyNotificationChannel` today would be a real security smell. **Also not
built yet**: any adapter code that actually calls a provider, and the scheduled job that would
detect "a vehicle crossed the alert threshold" in the first place — nothing in this codebase runs
on a timer today. `@nestjs/schedule` was added as a dependency (2026-08-27) anticipating that job,
but is not yet imported/wired into `AppModule` — pure groundwork, no behavior change.

**Self-service check-in** — client confirmed the proposed shape (basic schema now, real workflow
logic customer-specific later): `SelfCheckInRequest`, deliberately isolated from `Vehicle`/
`Driver`/`VehicleGateEntry` since a driver has no login/User account anywhere in this system — it
holds a driver's own unverified, self-submitted claim (vehicle number/name/phone/purpose as raw
text, no FK to a real `Vehicle`/`Driver`) until a security guard reviews it. Only on `ACCEPTED`
does `resultingGateEntryId` get set and a real `VehicleGateEntry` exist — a raw self-submission
never becomes an official record on its own. No endpoint exists yet (an unauthenticated write
surface, so building it needs its own care, not just wiring a CRUD controller the usual way).

**Migration**: `20260827100000_add_detention_notifications_self_checkin`, hand-written (`prisma
migrate dev` still refuses to run in this shell) and applied via `migrate deploy` — all new columns
nullable, all new tables start empty, no backfill needed. Docker Desktop had stopped since the last
session and needed restarting before Postgres was reachable — worth checking `docker compose ps`
first if `migrate deploy` fails with "Can't reach database server" rather than assuming a real
connectivity problem. Verified: `prisma validate`/`format` clean, `tsc --noEmit` clean, a full
`nest start --watch` boot showed "Nest application successfully started" with all existing routes
still mapped correctly (then hit `EADDRINUSE` immediately after — a different, already-running
server instance was live on port 3000 and responding HTTP 200 by that point, not one this session
started; left untouched rather than killed, since nothing in this pass changed any code path that
instance runs). **No throwaway-company script yet** — there's no service/controller logic to
exercise, only schema; that verification is for whenever the actual logic pass happens.

### Detention alerting: cron job + notification logic (2026-08-27, same day)
Follow-up pass, same session — the client asked to keep going into the actual logic rather than
stop at schema. Covers detention cost/alerting end-to-end and the notification send/audit/
escalation pipeline; self-service check-in and a real provider integration are still not built.

**Detention cost now shows up somewhere real**: `YardService.tracker()` (`yard.service.ts`) gained
a `detentionCost` field per row — `(elapsedHours / 24) × rate`, rate resolved as `Vehicle.
detentionCostPerDay ?? VehicleType.detentionCostPerDay`, `null` when neither is set (not a silent
zero). Computed live every call, never stored, same "always derive" philosophy as everything else
on that table. `GateYardPage.tsx`'s tracker table got a new "Detention Cost" column (`₹` formatted,
`—` when null) — the first place any of this schema is actually visible to a user.

**`backend/src/notifications/`** — new module, `NotificationsModule` imported into `AppModule`
alongside `ScheduleModule.forRoot()` (the latter enables `@Cron()` anywhere in the app; this is the
first timer-driven job this codebase has ever had).
- **`channels/`** — one file per channel (`EmailAdapter`, `SmsAdapter`, `WhatsappAdapter`) behind a
  shared `NotificationChannelAdapter` interface (`send(recipient, message) => {success, ...}`).
  **Every adapter is currently a stub** — logs what it would send via `Logger`, doesn't call any
  real provider. Swapping in MSG91/Twilio/SES/whatever later means rewriting one adapter file;
  nothing else in the pipeline changes. `SmsAdapter`/`WhatsappAdapter` both fail gracefully with
  "no phone number on file" — **`User` has no `phone` field at all**, a real gap flagged, not
  solved (adding one needs its own confirmation since it touches Login identity rules — see
  "Role & Access model").
- **`NotificationsService`** — `channelsFor(companyId)` resolves a company's enabled
  `CompanyNotificationChannel` rows, or defaults to `['EMAIL']` if none are configured yet (keeps
  the audit trail/escalation timer running even before a company picks a channel, since every
  adapter is a stub regardless). `sendAndLog()` writes a `NotificationLog` row, calls the adapter,
  updates status to `SENT`/`FAILED`. `acknowledge()` only lets the actual `recipientUserId`
  acknowledge their own notification (403 otherwise), idempotent on a second call.
- **`DetentionAlertScheduler`** — `@Cron(EVERY_5_MINUTES)`. For every company with
  `detentionAlertHours` set: finds open (`gateOutAt: null`) gate entries past that threshold with
  no existing `DETENTION_ALERT` log yet, and alerts every `WAREHOUSE_MANAGER` assigned to that
  entry's warehouse. For entries that already have an alert, unacknowledged and un-escalated, past
  `detentionEscalationHours` old: escalates to every `COMPANY_ADMIN` in the company, and stamps
  `escalatedAt`/`escalatedToId` on the original alert log(s). **Known gap, flagged not solved**: a
  warehouse with no `WAREHOUSE_MANAGER` assigned never gets an alert logged, so escalation (keyed
  off an existing alert) never fires either — nobody to escalate *from*. Revisit once this proves
  out with real warehouse data.
- **`NotificationsController`** (`GET /notifications`, `PATCH /notifications/:id/acknowledge`) —
  no `@Roles()` gate on either handler; every authenticated user can see/acknowledge only their own
  notifications (enforced by `recipientUserId` in the service), same "self access needs no role
  gate" shape as a User editing their own account. No frontend for this yet.

Verified: `tsc --noEmit` clean on both the yard-tracker change and the new module; a throwaway
instance booted on a spare port (3999, since a real dev server — not started by this session — was
already live on 3000) showed a fully clean start with `/notifications` routes mapped and no DI
errors, then was torn down. **Not yet verified**: the cron job has never actually fired against
real data (needs a company with `detentionAlertHours` set and a genuinely stale-enough gate entry
to test against — throwaway-company pass still to do), and there's no frontend for viewing/
acknowledging a notification.

### Detention cost: company-wide default rate + Company Settings page (2026-08-27, same day)
Third follow-up pass, same session — completing "the detention cost module" per the client's own
framing. Two real revisions came out of a short conversation before this got built, both worth
remembering:

**The rate is primarily company-wide now, not per-VehicleType.** Earlier the same day the client
had picked "per Vehicle Type + per-Vehicle override" as the primary shape; revisited once it came
time to actually wire up an input UI — most companies will just set one flat number for their
whole fleet, not price out every vehicle class ("we can ask the client to update this at the
start"). `Company.detentionCostPerDay` (`Decimal? @default(15000)` — the client's own placeholder,
"for now") is now the primary rate; `VehicleType`/`Vehicle.detentionCostPerDay` (built earlier the
same day) are kept as-is, demoted to optional refinement tiers for a company that wants more
granularity later. `YardService.tracker()`'s resolution order is now **Vehicle → VehicleType →
Company** — same override-when-known chain, just with a third fallback link. Every existing
company got backfilled to 15000 automatically (a nullable column with a constant DB `DEFAULT`
populates existing rows too, no separate backfill statement needed — migration
`20260827110000_add_company_detention_cost_default`).

**This is the first Company Settings surface this project has ever had.** A real, separate gap
surfaced building this: there was (and mostly still is) no Company-level settings endpoint or page
at all — every other per-company toggle (`requireEwayBillForOutboundGateOut`,
`blockGateInWhenYardFull`, `gatePassResetPeriod`, `restrictGateAccessToSecuritySupervisor`) has
only ever been set by hand in the DB during test passes, never through a UI. New
`backend/src/companies/` module (`GET`/`PATCH /companies/settings`, `COMPANY_ADMIN`-only,
`CompaniesService.requireCompany()` rejects `SUPER_ADMIN` — no single company for them to
configure) + `frontend/src/CompanySettingsPage.tsx` (new "Company Settings" nav tab, visible only
to `COMPANY_ADMIN`) — deliberately scoped to just the three detention fields
(`detentionCostPerDay`/`detentionAlertHours`/`detentionEscalationHours`) rather than building a
do-everything settings page in one shot. **Extend this same module/page when those other four
toggles get their own UI — don't build a second settings surface.** A blank field on Save sends an
explicit `null` (not just omitted), so an admin can actually clear a setting back to
"unconfigured," not just set new values.

Also finished the two smaller gaps flagged when this pass started: `VehiclesService.create()`/
`update()` now actually accept/validate/persist `detentionCostPerDay` (was silently dropped
before), and both the Gate & Yard "Register Vehicle" modal and Vehicle & Driver Master's Edit
Vehicle form gained a "Detention Cost/Day (₹)" input — the Vehicle & Driver Master table also
gained a "Detention Rate" column (shows the vehicle/type-level override only, `—` if neither is
set — deliberately doesn't show the company-fallback rate here, since that's a company-wide fact,
not a property of the row).

Verified end-to-end, twice: a throwaway-company API script (`DTCO28`) confirmed the default 15000,
a `PATCH` to 20000/4hrs/8hrs persisting, a per-vehicle override (₹500) taking precedence over the
company rate, a vehicle with no override correctly falling through to the company rate, and the
tracker's `detentionCost` math exactly matching `(hoursInParking/24) × rate` for both — including
reflecting the **updated** company rate for a vehicle that gated in before the `PATCH`, confirming
it's computed live at read time, never a stored snapshot. Then re-verified live in the actual
browser (logged in via the API+localStorage token trick): Company Settings page loaded and
pre-filled the real 20000/4/8 values; Vehicle & Driver Master's table showed "₹500/day" for the
override vehicle and "—" for the other; Gate & Yard's tracker showed "₹0.81" vs "₹32.29" for the
two open entries — a ~1:40 ratio matching the 500:20000 rate ratio exactly.

**One real, pre-existing bug surfaced during test cleanup, not caused by this pass**: `DELETE
/warehouses/all` throws a 500 instead of gracefully reporting "blocked" once a warehouse has linked
`VehicleGateEntry`/`YardSlot` rows — `WarehousesService.removeAll()`'s relation-count check (built
during the original Warehouse Master pass, before Yard & Gate existed) doesn't account for those
two relations. Flagged, not fixed — out of scope for detention. The throwaway company (`DTCO28`)
was left behind with 2 vehicles/1 driver/1 warehouse still linked to gate entries as a result (no
company-delete endpoint exists to fully clean it up either, same limitation as every other
throwaway-company session).

### Detention cost: correction — a real free-time window after all (2026-08-27, same day)
The client reversed the earlier "charge from hour 1, no grace period" call from the same day's
first detention pass: **"one mistake, you were right"**. Real rule now: free for the first
`Company.detentionFreeHours` (default 4 — "~4 hours," the client's own approximation), then the
full daily rate applies per 24-hour period measured **from the end of that free window**, not from
Gate In — so the full `detentionCostPerDay` amount is reached at `detentionFreeHours + 24` hours
after Gate In (28 hours by default), not at the 24-hour mark itself, and keeps scaling per
additional day beyond that. `YardService.tracker()`: `chargeableHours = max(0, totalHours -
freeHours)`, `cost = rate × (chargeableHours / 24)`. `detentionFreeHours` is the one detention
field on `Company` that legitimately allows `0` (a company that genuinely wants no grace period) —
validated as "not negative," not "must be positive," unlike the cost/alert/escalation fields.
Migration `20260827130000_add_company_detention_free_hours`; wired through `CompaniesService`
(`GET`/`PATCH /companies/settings`) and a new "Free hours" field on `CompanySettingsPage.tsx`,
same page as the other three detention settings.

Verified with backdated timestamps against the same throwaway gate entry (direct SQL `UPDATE
"VehicleGateEntry" SET "gateInAt" = NOW() - INTERVAL '...'`, company rate ₹20000/day, free hours
4): 2 hours elapsed → `detentionCost: 0` (within the free window); 10 hours elapsed (6 chargeable)
→ `₹5000.15` (expected exactly 5000); 28 hours elapsed (24 chargeable, the free-window-adjusted
"full day" mark) → `₹20000.15` (expected exactly the full 20000) — confirming the formula lands
precisely where the client specified. Then re-verified live in the browser: Company Settings' new
"Free hours" field loaded the real value (4) alongside the other three.

**Second correction, minutes later: not prorated — a flat step per full day.** "Don't keep a
proportional logic for now, just keep it simple, every 24 hours after the first 4 hours, 15k would
be added." Replaced `cost = rate × (chargeableHours / 24)` with `cost = floor(chargeableHours / 24)
× rate` — a vehicle owes nothing until it's completed a full 24-hour chargeable block, then the
full rate lands all at once, stays flat until the next full block completes, and so on. Re-verified
with the same backdating technique at four checkpoints on the same entry: 27 hours elapsed (23
chargeable, not yet a full day) → `₹0`; 28 hours (exactly 1 full day) → `₹20000` (the full rate,
landing all at once, not gradually); 51 hours (still short of a 2nd full day) → `₹20000` unchanged;
52 hours (2 full days) → `₹40000`. Confirms no partial credit anywhere between step boundaries.

### Dock assignment → automated driver notification (2026-08-27, same day)
Closes a real gap the client raised directly: nothing told a driver which dock to go to once
parked. This is the missing half of **Dock Scheduling** (still fully deferred as a real system —
see below) — a Security Supervisor manually types in the dock number they've been told, standing
in for that future system's output, and that single action fires an SMS + automated voice call to
the **driver's own phone** (not staff — a genuinely different recipient than every other
notification built earlier this session).

**Schema**: `VehicleGateEntry.assignedDockNumber` (free text — deliberately NOT a link to the
existing `DockDoor` records; it's capturing the Dock Scheduler's future output, not building real
dock-selection logic now) + `dockAssignedAt` (drives the warning timer, resets on every
reassignment). `NotificationChannel` gained `VOICE_CALL` (`ALTER TYPE ... ADD VALUE`, same pattern
as `SECURITY_SUPERVISOR`) — a genuinely different capability than SMS/Email/WhatsApp (telephony,
not messaging). New `DriverDockNotification` model — the audit trail, deliberately separate from
`NotificationLog` (that one's for `User` recipients only; a `Driver` has no login, is reached by
phone). `driverPhone` is snapshotted at send time, not read live from `Driver.phone` later, so this
stays real proof of what number was actually contacted even if it changes afterward.

**Backend, all inside `yard-gate/` (not a cross-module import into `notifications/`, keeping the
existing "every module owns its own `PrismaService`" self-contained convention)**:
`driver-channels/` (`DriverSmsAdapter`, `DriverVoiceCallAdapter` — both stubs, same "log what would
be sent" pattern as the staff-facing adapters; Exotel was the research lead for a real voice
provider, India-first, not chosen/wired up), `DriverNotificationService.sendDockAssignment()` (logs
one `DriverDockNotification` row per channel — SMS **and** the call, always both, not a choice
between them — and gracefully logs `FAILED` rows with a clear reason when a Driver has no phone on
file, rather than silently skipping), `DockAssignmentScheduler` (`@Cron(EVERY_5_MINUTES)`, checks
open entries 15+ minutes past `dockAssignedAt` with no `dockedInAt` yet and fires a `FINAL_WARNING`
— correctly scoped to the CURRENT assignment cycle only, comparing the last `FINAL_WARNING`'s
timestamp against `dockAssignedAt` so a stale warning from before a reassignment doesn't wrongly
suppress a new one). `GateEntriesService.assignDock()` (`PATCH /gate-entries/:id/assign-dock`) sets
the field and fires the `INITIAL` notification synchronously, in the same request — not queued.

**Explicitly NOT built, per the client's own scoping** ("in the dock scheduler this will be built
in"): nothing automatically reassigns the dock to the next vehicle after the 30-minute mark (15 min
initial + 15 min final warning) — that's the real Dock Scheduler's job, still fully deferred, not
this pass's. Also not built: whether a call was actually *answered* (vs just dialed) — the client's
own call, "a good valid suggestion" but "a later upgrade"; today's proof is only "dialed/sent at
this time," matching exactly what was asked for now.

**A real process note**: framing the free-text-vs-`DockDoor`-link question as if it reopened Dock
Scheduling's design drew direct pushback — "the output of the dock scheduler should be the input to
the security, i have told 10000 times we will do it!" The actual dock-selection system is the
already-settled placeholder; a field just capturing what a human would type in standing in for that
system's eventual output isn't a new instance of the same open question. See
[[wms-align-before-coding]] in memory — updated with this exact example so it isn't repeated again.

Verified end-to-end via a throwaway-company API test plus a direct DB check (no endpoint exists to
read `DriverDockNotification` — deliberately not built, this session only needed schema + the
trigger logic): assigning Dock 7 to a vehicle with a driver who has a phone on file produced exactly
two rows (`SMS`/`VOICE_CALL`, both `SENT`, `driverPhone` correctly snapshotted, message text
correct) with real timestamps; `assignedDockNumber`/`dockAssignedAt` both showed correctly on the
entry response and on `/yard/tracker`. Then re-verified live in the actual browser: the tracker
table's new "Dock" column showed "Assign" for unassigned rows and "Update" + "since <time>" for the
one just assigned via the API, with the input pre-filled with the real saved value ("7"). **Not yet
verified**: the 15-minute `FINAL_WARNING` cron path itself (would need either a real 15-minute wait
or the job invoked manually against a backdated `dockAssignedAt`), and the no-phone-on-file `FAILED`
path (exercised implicitly via an earlier driver with no phone registered, not directly asserted).

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

**Export was extended to Warehouse/Customer/Location/User** (2026-08-24), matching SKU's pattern
exactly: a `GET /<resource>/export` endpoint (`exportRows()` in the service, `MASTER_DATA_READ_ROLES`-
or `CAN_MANAGE_USERS`-gated same as the resource's other reads) building rows via `json_to_sheet` →
`.xlsx` buffer, and a `handleExport()` on the frontend page (`fetch` → `.blob()` →
`URL.createObjectURL` → synthetic `<a download>` click), copy-pasted verbatim from `SkusPage.tsx`.
For Warehouse and Customer — whose import already groups repeated rows under one parent key
(Location Code / Bill To ID) — export mirrors that shape in reverse: **one row per (parent, child)
pair** (Warehouse × Storage Type, Customer × Ship-to), so an exported file edits and re-imports
unchanged; a parent with zero children still gets one row (blank child columns) so it isn't dropped.
Warehouse's Dispatch Flows have no natural per-row slot to repeat into, so they're joined as one
comma-separated column instead, repeated identically on every row for that warehouse. Location
export intentionally names its sheet `Location Import` — the same name its own importer reads —
so an exported file round-trips through re-import with no manual rename. User export excludes any
password/password-hash column on purpose (a hash can't be reversed, and re-exporting one anywhere
would be a real security smell).

Verified end-to-end via a throwaway-company test script (25/25: correct row-shape and grouping for
all four, Dispatch Flow joining, Ship-to warehouse-code resolution, the Location-Import round-trip
actually re-importing and correctly flagging every row as a pre-existing duplicate, User export
never containing a password field, and Operator correctly blocked (403) from every export
endpoint) plus a live browser check confirming the real Export buttons on Warehouse and User pages
trigger the correct request.

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

### Warehouse ↔ Location cross-check: Storage Type Mapping (2026-08-25)
`WarehousesService.getMappingSummary()` (`GET /warehouses/mapping-summary`) + a "Storage Type
Mapping — Planned vs. Generated" table on `WarehousesPage.tsx` — cross-checks each `WarehouseStorageType`
row's planned `palletPositions` against how many pallet positions actually exist among that
warehouse's generated `Location`s, so nothing gets missed during bulk generation. Rack `Location`s
count as 1 pallet position each (individually addressable, same assumption `attachCapacity()` already
makes); Ground/Stillage use their derived `depth×width×height` capacity.

**Deliberately one-directional** — this answers "did we forget to generate something planned for,"
not "does every generated Location have a matching planned row." A Location whose (storageType,
categoryId) doesn't match any planned row at all is simply invisible to this summary, not flagged as
"extra" — that's a different, not-yet-asked-for feature.

**Three matching decisions, confirmed rather than assumed:**
- A Location with no Category set still counts — matched into the "Uncategorized" bucket the same way
  a blank Category always resolves elsewhere in this codebase, not tracked separately as unverifiable.
- Deactivated Locations still count — the physical bin exists either way, active or not.
- A warehouse-level `Mix` row (not yet broken down by real storage type) is skipped entirely, from
  both the per-row listing and the totals — there's nothing concrete to compare it against, and a
  warehouse that hasn't broken its `Mix` value down yet simply doesn't get this cross-check for that
  row ("their loss" — a deliberate stance, not an oversight; `Mix` can't coexist with real Storage
  Type entries on the same warehouse anyway, per existing validation).

**Table shape** mirrors the existing "Customers per Warehouse" rollup below it on the same page — one
row per (Warehouse, Storage Type, Category), a bold Total row per warehouse, the Mapped number colored
green when it meets/exceeds Planned and crimson (bold) when it falls short. A warehouse with zero
non-Mix planned rows doesn't appear in the table at all.

Verified via a throwaway-company test script (7/7): a warehouse with SPR planned 10/mapped 6
(under-mapped, confirmed crimson) and Ground/Floor planned 8/mapped 8 (exactly met, confirmed green),
totals summing correctly (18 planned/14 mapped); a separate Mix-only warehouse confirmed to produce
zero rows. Then re-verified live in the browser: the table renders with the exact expected numbers and
colors (crimson `6`, green `8`, crimson `14` total).

### Locations/Bins Plan View: Storage Type colour-coding (2026-08-25)
Each Plan View box is now filled/bordered by its `storageType` — one of five fixed colours (`SPR`
blue, `Drive-in` purple, `ASRS` teal, `Ground/Floor` orange, `Stillage` pink), light pastel fills so
the existing black text stays legible. A legend below the summary paragraph lists only the Storage
Types actually present in the warehouse being viewed, not all five always. An inactive box keeps its
existing grey-fill/dashed-border treatment regardless of storage type — that signal stays distinct
from colour-by-type, not blended into it. Verified live: a warehouse with SPR (blue) and Ground/Floor
(orange) locations rendered exactly those two fill/stroke colour pairs and both legend entries, no
others.

### Every master-data entity gets a "Delete All" — build it in from day one
Warehouses, SKUs, and Customers all have a `DELETE /<resource>/all` endpoint (`removeAll` in the
service) plus a "Delete All" button in the list-page UI, wired up from the start rather than
added later — this is a deliberate standing convention, add it when scaffolding any new
master-data module, not as an afterthought. Pattern: scope to `companyFilter(user)`, then for
each record count linked child/transaction records via a Prisma `_count.select` across every
relation that would otherwise block a raw delete (see `WarehousesService.removeAll` — checks
`assignedUsers`, `shipToAssignments`, `locations`, `inboundReceipts`, `outboundOrders`,
`stockMovements`, `gateEntries`), skip (and report as "blocked") any record with links, bulk-delete
the rest. Entities with only cascade-safe children and no real downstream FK (e.g. `Customer` →
only `CustomerShipTo`) skip the blocking check and just delete children-then-parents in a
`$transaction`, matching their single-record `remove()`. **Route order matters**: `@Delete('all')`
must be declared before `@Delete(':id')` in the controller, or Nest matches `all` as an `:id`
param and the literal route never fires.

**A real bug lived here for two full modules' worth of time, caught 2026-08-27**:
`WarehousesService.removeAll()`/`remove()`'s blocking check was written before Yard & Gate existed
and never learned about it — `gateEntries` wasn't in the `_count.select`, so a warehouse with real
gate-entry history got wrongly marked "deletable," and the raw `DELETE` hit Postgres's actual FK
constraint, surfacing as an unhandled 500 instead of the intended graceful "blocked" result.
**Lesson for any future relation added to an entity that already has a `removeAll`/`remove`**: go
back and add it to that entity's blocking check too — it doesn't happen automatically just because
the FK exists. Fixed by adding `gateEntries` to the count (real transaction history, blocks like
`stockMovements` does) and adding `yardSlots`/`dockDoors`/`gatePassSequences` as cascade-deleted
child rows in the transaction (config with nothing else referencing them via FK, same tier as
`storageTypes`/`dispatchFlows` — safe once `gateEntries` is confirmed zero, since no
`VehicleGateEntry` could then be pointing at any of that warehouse's `YardSlot`s either). Verified
against both the exact bug scenario (a warehouse with linked gate entries → now a clean `200`
`blocked` response, not a 500) and the happy path (a warehouse with real `YardSlot` rows and a
`DockDoor` but no gate entries → still deletes cleanly with the new cascade cleanup).

**Never smoke-test a `DELETE .../all` endpoint against real/seed data, even to verify a fix** —
create disposable throwaway records, exercise the endpoint against those, and clean up
afterward. Also let `nest start --watch` finish restarting (watch the log for a stable "Nest
application successfully started" line with no further restarts) before firing a destructive
request — mid-restart requests have run against a stale in-memory build of the service and
bypassed logic that was actually correct in the saved source. This wiped a real test company's
warehouses and a customer during development (2026-08-23); see git history / conversation if you
need the details. This applies doubly once real per-warehouse Inventory/Location data exists.

### User.phone, and proving the detention alert cron actually fires (2026-08-27, same day)
Two small follow-ups, picked directly off the "what's left" list from earlier in the session.

**`User.phone`** — closes the gap flagged when notifications were first built: only `Driver` had a
phone field, so a staff-facing SMS/WhatsApp alert had nowhere to send to. Purely a contact field,
no login/identity impact (`email` stays the login ID either way) — same nullable, no-uniqueness
shape as `Driver.phone`. Wired through the same places `functionTag` already was: `SELECT_SAFE` in
`users.service.ts`, manual create/edit, bulk import (both the row-mapping in `users.controller.ts`
and the actual `User_Master_Import_Template.xlsx`, updated in both `templates/` and
`frontend/public/templates/` copies via a script — a new "Phone" column between Function Tag and
Warehouse Code(s), plus a Legend & Rules row), export, `UsersPage.tsx`'s form/table/search.
`NotificationsService.sendAndLog()` now actually selects and passes `phone` to the channel adapter,
so SMS/WhatsApp to staff will work the moment a real provider exists — previously it silently only
ever had an email to work with. Migration `20260827140000_add_user_phone`.

**Proving the cron fires** — `DetentionAlertScheduler` had logic but had never been exercised
against real data. Verified for real (not just reasoned about): registered a `WAREHOUSE_MANAGER`
with a phone, assigned to the throwaway warehouse; set `Company.detentionAlertHours = 2`; backdated
an open gate entry's `gateInAt` to 3 hours ago (same SQL-backdating technique as the detention-cost
verification); then genuinely waited for the real `@Cron(EVERY_5_MINUTES)` to hit its next
wall-clock mark (fires on `:00/:05/:10...`, not "5 minutes after setup" — worth remembering when
timing a wait for this specific job). It fired exactly on schedule: a real `NotificationLog` row
appeared — `DETENTION_ALERT`, `EMAIL` (the fallback channel, since this throwaway company never
enabled any `CompanyNotificationChannel`), `status: SENT`, correct recipient (the Manager just
registered), correct message text. First genuine end-to-end proof of the whole pipeline: cron
detection → recipient resolution → `NotificationsService.sendAndLog()` → stub adapter →
`NotificationLog` persisted. Escalation (`detentionEscalationHours`) was configured but not
separately re-verified live — it's keyed off the alert's own timestamp being old enough
unacknowledged, which would take a real hour-plus wait to observe firsthand; traced through the
code instead rather than spending that time.

### Seal/signature, physical condition inspection, and commodity description (2026-08-27)
Follow-up to a competitor-research pass (Blue Yonder/Infor YMS gap analysis — see the
`wms-yms-competitor-research` memory for the full list and what got explicitly skipped/deferred).
Three cheap, confirmed-in-conversation additions to `VehicleGateEntry`, all optional fields, no new
tables, no new events:

- **`commodityDescription`** — free-text cargo visibility, captured at Gate In, either direction.
- **`physicalConditionOk`/`physicalConditionRemarks`** — the truck/trailer's own physical condition
  (dents, tyres), deliberately separate from `GateEntryDocumentCheck`'s paperwork checks. Flat, no
  photos, no itemized checklist — "not mature enough for photos yet," the client's own call.
  Captured alongside **Dock In**, for BOTH directions — there's no separate "loading start" event in
  this system to hang it off instead.
- **`sealNumber`/`sealSignatureData`(+`sealCapturedAt`/`sealCapturedById`)** — cheap dispute-
  resolution fields ("was the seal intact when it left/arrived"). Timing branches by purpose, same
  pattern `eWayBillNo`/`materialReceivedConfirmed` already use: **Inbound** captures it at **Dock
  In** (the seal the truck arrived with, checked before unloading); **Outbound** captures it at
  **Gate Out** (sealed right after loading — the client said "after dock out," but this system has
  no separate Dock Out event, so — same reasoning as E-Way Bill, captured at the identical moment —
  it lands on the existing Gate Out step instead, confirmed with the client before building).
  `sealSignatureData` is a base64 PNG from a new `SignaturePad` component (`GateYardPage.tsx`) — the
  first signature-capture UI in this codebase, plain `<canvas>` + pointer events (mouse and touch
  both), no library. No blob/asset storage exists in this project, so the drawing is stored as text
  straight into a Prisma `String` column (Postgres `TEXT`, no length concern for one small image).

**Deferred from the same research pass, explicitly not built this round** (see the memory for full
reasoning): a driver/carrier self-service portal (`SelfCheckInRequest` stays schema-only), a Drop
Trailer vs. Live Load flag (would need real tractor/trailer decoupling to be meaningful, not just a
flag — parked, not scoped), and a Yard Plan View (`YardSlot` has no spatial data to visualize yet —
needs its own small design pass, same as Locations' Plan View did).

**Backend**: `dockIn()` now takes a request body (previously none) — `GateEntriesController`/
`GateEntriesService` both updated; `gateOut()` gained the two seal fields, set only when actually
provided (so Inbound's Dock-In-captured seal is never clobbered by a later Gate Out call). Export
(`exportRows()`) gained Commodity Description, Physical Condition OK/Remarks, and Seal Number
columns (deliberately not the signature image — too large/not spreadsheet-appropriate).

**Frontend**: Commodity Description added to the existing Gate In form. **"Mark Docked In" is now a
modal, not a single-click button** — collects physical condition (OK/Flagged radio + remarks) for
both directions, plus Seal Number + `SignaturePad` for Inbound only. The existing Gate Out modal
gained the same Seal Number + `SignaturePad` pair, shown only for Outbound.

Verified two ways: a throwaway-company API script, 25/25 checks passing (commodity description at
Gate In; physical condition OK/Flagged + remarks at Dock In both directions; Inbound seal captured
at Dock In and confirmed to survive an unrelated Gate Out untouched; Outbound Dock In confirmed to
have NO seal; Outbound seal captured at Gate Out; export returning 200 with content). Then re-
verified live through the actual rendered UI (logged in via the API+localStorage token trick): ran a
real Inbound Gate In with a typed Commodity Description, opened the new Dock In modal and confirmed
it showed the physical condition radios + Seal Number + signature pad (Inbound), submitted, and
confirmed via the actual network response that all fields persisted correctly; ran the Gate Out for
that entry and confirmed no seal fields appear for Inbound; ran a fresh Outbound Gate In, opened
Gate Out, confirmed Seal Number + signature pad DO appear there (and only there) for Outbound, and
confirmed the submitted seal number persisted. Signature drawing itself was exercised through the
component's logic but not literally mouse-dragged during the live browser pass (no reliable pixel
coordinates without a visible screenshot) — `sealSignatureData` round-tripping was fully confirmed
by the API script instead. Docker Desktop had also stopped since the last session (same recurring
gotcha as before) and needed restarting before the migration could be applied.

### Inbound receiving — order maker, order match, and scan-based receiving (2026-08-27)
The first real build on Inbound, the next stage in the module build order after Master Data and
Yard & Gate. Followed a long, deliberate align-before-coding conversation (real workflow — vehicle
readiness, dock allocation, order matching, scan-by-scan receiving, and the tyres/FMCG-case
barcode-uniqueness problem) before any schema/code — see git history for the full back-and-forth if
the reasoning behind a specific design choice needs revisiting.

**The five-step flow, confirmed with the client**: (1) a manual "order maker" creates an
`InboundReceipt` + expected SKU/qty lines — ERP push is a schema-ready toggle
(`Company.allowErpInboundPush`) but explicitly NOT built this pass, manual only, per the client's
own build-order call; (2) once Gate In's documents all come back OK, every Warehouse Supervisor/
Manager on that warehouse gets notified the vehicle is ready for unloading
(`NotificationEventType.VEHICLE_READY_FOR_UNLOADING`, same broadcast shape `DETENTION_ALERT`
already uses); (3) Dock Door assignment stays exactly as it already was (unchanged this pass); (4)
once Docked In, a **second, authoritative** PO/invoice number gets entered — deliberately separate
from Gate In's loose free-text `referenceNo` — which resolves against a real `InboundReceipt` and
locks it to this one gate entry (`VehicleGateEntry.inboundReceiptId`, `@unique`); (5) every physical
item then gets scanned during receiving.

**Scanning: capture is universal, interpretation is tiered** — the key design resolution from the
conversation. A real 1,000-tyre truck can't be manually quantity-typed, so every scan gets captured
as an `InboundReceiptScan` row regardless of whether the system can make sense of it yet:
- **Resolution is scoped to the matched receipt's own expected lines, never company-wide barcode
  uniqueness** — the client's own correction mid-conversation: a real barcode can legitimately repeat
  across unrelated SKUs (ERP dumps aren't always clean), so a scan only needs to be unambiguous
  *within this one receipt's remaining expected lines*, not globally unique.
- A scan that resolves cleanly (`SkuBarcode` → `SkuStorageUnit.qtyInBaseUom` for the quantity
  multiplier — 12 for a case, 1 for a tyre — matching a real remaining expected line) is
  **ACCEPTED** immediately: posts a real `StockMovement` (`RECEIPT`) and increments that line's
  `receivedQty` — the first-ever write to that ledger anywhere in this codebase.
- Anything else — wrong SKU, would exceed that line's expected qty, or a barcode the system simply
  can't interpret yet (a composite GS1-128 case barcode, a unique per-tyre serial — real parsing of
  those, "Reading B," is explicitly deferred, not built) — is **BLOCKED**. The scanning operator can
  never resolve their own blocked scan (enforced by role gating, `INBOUND_APPROVE_ROLES` excludes
  `OPERATOR` — the client's own instruction). A Supervisor either **APPROVEs** it (confirms the real
  SKU/line/quantity, which then posts exactly like an accepted scan, permanently flagged in the
  record as a reviewed override) or **REJECTs** it (a genuine mis-scan/duplicate, no stock impact).
- **Reconciliation is per-(SKU, quantity), never a blended total** — `InboundReceipt.status` only
  reaches `RECEIVED` when *every* line's `receivedQty` exactly equals its own `expectedQty`; one
  short/over line keeps the whole receipt at `PARTIALLY_RECEIVED` even if unrelated lines are
  perfect and an aggregate sum would otherwise look right. This was a specific, deliberate
  client correction — an early framing risked a blended-total check that could silently hide a real
  over/under-receipt on one SKU offset by another.
- Gate Out's old `materialReceivedConfirmed` checkbox (a manual placeholder since the day it was
  built, explicitly commented as such) is now driven by real receipt status once a receipt is
  matched — falls back to the old manual checkbox only for an Inbound entry that was never matched
  to a real order at all, so nothing regresses for a company not yet using this flow.

**Schema**: `InboundReceiptScan` (new — the per-scan audit/status log), `SkuBarcode.storageUnitId`
(new, nullable — links a barcode to its pack-level `SkuStorageUnit`, defaults to "1 each" when
unset so every pre-existing barcode keeps working unchanged), `VehicleGateEntry.inboundReceiptId`
(new, `@unique`), `Company.allowErpInboundPush` (new toggle, unused this pass).

**Backend**: new `inbound/` module (`InboundReceiptsController`/`Service` — the order maker,
`GET`/list/detail, and the Supervisor approve/reject actions) alongside new methods on the existing
`GateEntriesService` (`matchReceipt`, `scan`) and a modified `create()`/`gateOut()`. `NotificationsModule`
now `exports: [NotificationsService]` and `YardGateModule` imports it — the first real cross-module
service reuse in this codebase (every module before this just queried Prisma directly rather than
importing another module's service; duplicating the whole send/audit/adapter pipeline would have
been a much bigger cost than this one import). `recomputeReceiptStatus` is intentionally duplicated
between `GateEntriesService` and `InboundReceiptsService` rather than shared cross-module, matching
that same "each module queries Prisma directly" convention for the smaller cases.

**Frontend**: new `InboundOrdersPage.tsx` (the order maker + order list, new "Inbound Orders" nav
tab) and a substantial `GateYardPage.tsx` addition — "Match Order" and "Receive" actions on a
docked Inbound row, a Match Order modal, and a Receiving modal (expected-lines table, a plain text
scan input that a hardware scanner works against as-is via keyboard-wedge input, a live scan log,
and inline Supervisor approve/reject controls on any blocked scan). **A camera-scan toggle
("scanner or phone, ready for either") is a deliberate, flagged v1 gap — not built.** No barcode-
decoding library exists in this codebase; only the hardware-scanner-compatible text input path is
real. Gate Out's Inbound checkbox now only renders when no real order is matched — showing a
now-unused checkbox once a receipt is matched would be actively misleading, caught live while
verifying this pass.

**A real bug caught and fixed during live verification, not the automated script**: `approveScan`
originally required the client to also pass a `skuId` alongside `receiptLineId`, redundant since a
line already determines its SKU unambiguously — the Receiving UI's approve form was only ever built
to collect a line + quantity, so every real approval 400'd until this was caught clicking through
the actual UI and fixed by deriving `skuId` from the chosen line server-side instead of requiring it
from the client. The original 29-check API script had passed because it happened to pass `skuId`
by hand — a good example of why the live-browser pass catches things the API script alone doesn't.

Verified two ways: a throwaway-company API script, 29/29 (order creation, duplicate-reference
rejection, vehicle-ready notification firing to a real registered Manager, match-receipt blocked
before Dock In, a clean case-barcode scan auto-accepting with the right quantity, an unrecognized
barcode correctly BLOCKED, a Supervisor APPROVE correctly reconciling the line and flipping the
receipt to `RECEIVED`, a would-exceed-quantity scan correctly BLOCKED and REJECTED, Gate Out
succeeding purely off real receipt status with no manual checkbox, and exactly 2 real `StockMovement`
RECEIPT rows summing correctly). Then re-verified live through the actual rendered UI end to end
(order created through the real form, a real Gate In/Dock In/Match Order/scan/Supervisor-approve/
Gate Out cycle) — this is where the `approveScan` bug above was actually caught, confirming the value
of the second pass beyond what the API script alone had already proven.

**Explicitly deferred, not part of this build**: full GS1-128/DataMatrix barcode parsing and
unique-per-item/pallet tracking ("Reading B" — see the earlier competitor-research conversation,
still the same combined future topic), ERP push for order creation, camera-based scanning, and
Putaway (the next module — `PutawayTask` already exists in schema, hangs off `InboundReceiptLine`,
untouched this pass).

**Follow-up, same day: staging location moved from the order maker to Match Order.** A real gap
the client caught after this all shipped: `InboundReceiptLine.stagingLocationId` was originally
*required* at order-creation time — but nobody can know where a delivery will physically be staged
before the vehicle even exists in the system. The client's own proposed fix (linking a Dock Door to
a handful of candidate staging blocks) was a real, legitimate pattern but was rejected for now:
`VehicleGateEntry.assignedDockNumber` is deliberately free text, not a link to a real `DockDoor`
row (a placeholder for the still-unbuilt real Dock Scheduler), so a mapping built against it today
would be fragile and need rebuilding once Dock Scheduling is real — flagged as a good enhancement
to revisit *then*, not now.

The actual fix: **`InboundReceipt` gained its own `stagingLocationId`** (nullable, `Location`), set
once at the **Match Order** step (`GateEntriesService.matchReceipt()`) — now required there, since
that's the first real moment staff knows where they're unloading. `InboundReceiptLine.
stagingLocationId` stays as an optional per-line override (a specific SKU that genuinely needs a
different spot), falling back to the receipt's own default everywhere a scan needs a real
`Location` to post a `StockMovement` against (`GateEntriesService.scan()`,
`InboundReceiptsService.approveScan()`). The order maker itself no longer asks for a staging
location at all (relabeled "Staging Location Override" with a note explaining why it's normally
left blank); `matchReceipt`'s existing controller/frontend both extended to carry it.

**A real bug caught live, not by the API script**: `approveScan` originally required the client to
pass `skuId` separately from `receiptLineId`, even though a line already determines its SKU
unambiguously — the Receiving screen's approve form was only ever built to collect a line +
quantity, so `skuId` was silently always missing and every real approval 400'd. The original
29-check script had passed because it happened to supply `skuId` by hand. Fixed by deriving `skuId`
from the chosen line server-side instead of accepting it from the client at all — this is the
second time in this same feature that the live-browser pass caught something the API script alone
had missed, worth remembering as a reason not to skip that second verification step even when the
API script is green.

Verified via a new 10-check throwaway-company script (order creation without a staging location
succeeds; `matchReceipt` without one is rejected; with one succeeds and shows up on the gate
entry's `inboundReceipt.stagingLocation`; an unrecognized scan blocks; approving it without an
explicit `skuId` succeeds and resolves the right SKU from the line; the receipt reaches `RECEIVED`)
plus a live browser pass — opened Match Order on a real docked entry, confirmed the Staging
Location field actually renders and lists the real warehouse's locations, submitted it, and
confirmed the Receiving modal's header shows "staging at GF-S1-BLK01" pulled from the real saved
value.

### Inbound receiving moved off Gate & Yard entirely (2026-08-27, same day)
A real architecture correction from the client, caught after the whole flow above had already
shipped and been tested: "this cant be in the yard management page at all" — Dock In's physical
condition/seal capture, Match Order, and Receiving/scanning were all still living inside
`GateYardPage.tsx`, mixed in with Gate In, dock assignment, and Gate Out. That's wrong: the
inbound/warehouse team who actually does receiving is a different audience than the security/gate
staff Gate & Yard is for — a distinction this system had already half-established (the
`VEHICLE_READY_FOR_UNLOADING` notification only ever targeted Supervisors/Managers, never Security
Supervisor) but hadn't carried through to the page layout.

**The split, confirmed in conversation**: Gate & Yard keeps Gate In, dock assignment, and Gate Out
for every direction — unchanged. **Dock In itself also moved**, not just physical condition — for
an Inbound Delivery, "Mark Docked In" no longer appears on Gate & Yard at all; the inbound team
does it themselves on **Inbound Orders**, which is now the whole inbound workflow's home: create an
order, then a **"Vehicles Ready for Receiving"** queue (every open Inbound gate entry, state derived
straight from `dockedInAt`/`inboundReceiptId` — no dependency on Gate & Yard's yard-tracker data)
drives Mark Docked In → Match Order → Receive, all in one place. Outbound/Returns keep Dock In on
Gate & Yard exactly as before — there's no separate "outbound team" page in this design, so no
reason to move it there.

**No backend/schema changes needed at all** — this was a pure frontend relocation. `dockIn()`/
`matchReceipt()`/`scan()`/`approveScan()`/`rejectScan()` are all purpose-agnostic at the API level;
they never cared which page called them. `GateYardPage.tsx`'s `GateEntry` type, `emptyDockInForm`,
and `handleDockInSubmit` all dropped their seal-related fields (`sealNumber`/`sealSignatureData`)
entirely — those were always Inbound-only, so Gate & Yard's Dock In modal is now just physical
condition, nothing else. `InboundOrdersPage.tsx` gained its own copy of `SignaturePad` (this
codebase has no shared component library, same "duplicate per page" convention as everywhere else)
plus the full Dock In/Match Order/Receiving modal set ported over close to verbatim.

Verified live through the actual rendered UI: confirmed Gate & Yard's tracker row for an already-
docked Inbound vehicle now shows only Assign Dock + Gate Out (no Match Order/Receive button
anywhere on that page); confirmed the same vehicle correctly appears on Inbound Orders' new
"Vehicles Ready for Receiving" queue with the right derived status ("Order PO-UI-STAGE-1 —
Pending") and a working Receive action; opened Receiving from its new home and scanned a real case
barcode, which correctly BLOCKED (12-unit case exceeding this order's 5 remaining units) with the
Supervisor override controls rendering inline exactly as before the move — confirming the
relocation didn't regress any of the underlying logic, only where it lives.

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

**Nav bar: a "Masters" dropdown groups the six master-data pages** (2026-08-27, the client's own
simplicity call — the top-level nav was getting crowded as more pages got added). Warehouses/SKUs/
Customers/Locations/Vehicle & Driver Master/Users now live under one `App.tsx` dropdown (`Masters ▾`,
closes on an outside click via a plain `document.addEventListener('mousedown', ...)` — no library),
bolded when the active tab is one of the six. Gate & Yard, Inbound Orders, and Company Settings stay
as standalone top-level buttons, unchanged — the client's explicit "rest you can keep as it is for
now." `Users` is still filtered out of the dropdown for a role outside `CAN_MANAGE_USERS`, same gate
as before. Apply this same "operational workflows stay top-level, master-data lists go in the
dropdown" split to any new page — a page that's mostly CRUD over a list belongs in Masters, a page
that's a daily task/workflow (like Gate & Yard or Inbound Orders) stays top-level.

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
capacity for ground/stillage bins, and role/warehouse scoping matching Warehouse/Customer. Also has
a bulk range-generator (`POST /locations/generate` — expand a Rack/Ground/Stillage range into many
rows in one call), Excel bulk import, an edit UI, Warehouse/Zone Type/Storage Type/text filtering on
the list, and a Table View/Plan View toggle rendering a static top-down structural floor plan of a
selected warehouse's generated layout — see "Locations/Bins zone & storage model", "Locations/Bins:
range generator, Excel import, edit UI, filtering", and "Locations/Bins: Plan View visualizer" above
for the full design and what's still deliberately deferred (Plan View's click-to-inspect and Zone
Type coloring, Putaway/slotting logic). See "Platform-managed reference data"
above for `ProductCategory`/`CategoryPackSpec`, the repository pattern behind several of these.

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
integration, and — per the module build order above — Putaway, Inventory, Outbound, Picking,
Dispatch, Analytics (**Inbound now has real first-pass logic** — see "Inbound receiving" below,
not just schema anymore). Cloud/production deployment hasn't happened; this is local Docker
Compose (Postgres) only.

**Inbound receiving** (2026-08-27, see "Inbound receiving — order maker, order match, and
scan-based receiving" above for the full design and what's verified) — the manual order maker,
vehicle-ready notification, order matching at the dock, and scan-based receiving (auto-accept for
a clean barcode match, Supervisor-approve/reject for anything blocked, per-line not blended
reconciliation) are all real, working, and live-verified end-to-end, including the **first-ever
write** to the `StockMovement` ledger anywhere in this codebase. ERP push, full GS1/unique-instance
barcode parsing (the tyres/FMCG-case "Reading B" problem), camera-based scanning, and Putaway
itself are all explicitly deferred, not built this pass.

Also worth knowing (2026-08-27) — see "Detention, multi-channel notifications, and self-service
check-in", "Detention alerting: cron job + notification logic", and "Detention cost: company-wide
default rate + Company Settings page" above for full detail: **detention cost is now fully built
and live-verified end-to-end** — a company-wide default rate (`Company.detentionCostPerDay`,
defaults ₹15000/day) with optional Vehicle/VehicleType overrides, a real input UI (Company
Settings page + Vehicle register/edit forms), and the computed cost showing on the Gate & Yard
tracker table. **Detention alerting** (the cron job that notifies a Manager/escalates to the
Company Admin) also has real logic, and has now been **proven to actually fire against real data**
(see "User.phone, and proving the detention alert cron actually fires" below) — but **every
notification channel is still a stub** (logs only, no real SMS/Email/WhatsApp provider chosen or
wired up, no API keys exist anywhere). `User` now has a `phone` field (added same day, closing what
used to be a hard blocker here) so staff SMS/WhatsApp has somewhere to send to once a provider
exists. **Self-service driver check-in** is still schema-only (`SelfCheckInRequest` exists, no
endpoint, no UI). ASN stays fully deferred until Inbound starts — no schema for it at all yet. A
real, pre-existing bug was also found and **fixed** the same day: `WarehousesService.removeAll()`/
`remove()` used to throw a 500 instead of gracefully blocking when a warehouse had linked
`VehicleGateEntry`/`YardSlot` rows — see "Every master-data entity gets a Delete All" above for the
fix. **Dock assignment → driver notification** (see its own section above) is also now built and
live-verified — a Security Supervisor types a dock number against an open gate entry, which
immediately SMS's + calls the driver (`DriverSmsAdapter`/`DriverVoiceCallAdapter`, both stubs — no
real provider chosen, Exotel was the research lead for voice) and logs proof of the attempt
(`DriverDockNotification`). A 15-minute final-warning follow-up is automated
(`DockAssignmentScheduler`); actually reassigning the dock to the next vehicle after that stays
fully deferred to the real Dock Scheduler, which itself still has no schema/design work done at all
— only its eventual OUTPUT (a dock number) has anywhere to land now.

Also worth knowing (2026-08-27, same day, later pass) — see "Seal/signature, physical condition
inspection, and commodity description" above: a competitor-research pass (Blue Yonder/Infor YMS —
see `wms-yms-competitor-research` memory) led to three more small, confirmed additions, all
built and live-verified — commodity/cargo description at Gate In, a flat physical condition
inspection (no photos) at Dock In for both directions, and seal number + a new canvas-based
signature capture (Inbound at Dock In, Outbound at Gate Out). The same pass explicitly deferred a
driver self-service portal, a Drop Trailer/Live Load flag, and a Yard Plan View — none of those are
built.

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

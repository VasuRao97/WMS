# Role & Access Reference

_WMS — who can see, create, and edit what. Last updated 2026-08-24, verified end-to-end
(37/37 automated allow/deny checks passing)._

This is the plain-language version. For the code-level detail (file names, function names),
see the "Role & Access model" section of `CLAUDE.md`.

## The four roles

| Role | Who they are | Scope |
|---|---|---|
| **Company Admin** | The client's warehouse team lead / the account created at registration | All warehouses, full company |
| **Warehouse Manager** | Runs one or more specific warehouses | Only their assigned warehouse(s), full access within them |
| **Warehouse Supervisor** | Inbound / Outbound / Inventory / Shift supervisor (or a generic "does everything" supervisor, for companies that don't split the role) | Same warehouse(s) as their Manager, but view-only |
| **Operator** | Day-to-day floor staff — packing, picking, putaway, loading/unloading | No system access to master data at all — their screen is a future handheld task screen, not built yet |

There is a fifth, platform-level role, **Super Admin**, that sits above all of this and sees every
company. There's no controlled way to create one yet — not part of this build.

## Who can create — and edit, and deactivate — whom

Each role can create/manage any role **strictly below it**, except Company Admin, which can also
create another Company Admin (co-admins are allowed for larger client teams):

```
Company Admin ──creates──▶ Company Admin, Warehouse Manager, Warehouse Supervisor, Operator
Warehouse Manager ──creates──▶ Warehouse Supervisor, Operator
Warehouse Supervisor ──creates──▶ Operator
Operator ──creates──▶ (nobody)
```

The same rule governs editing an existing account and deactivating one — a Manager can edit or
deactivate any Supervisor/Operator in their own warehouse(s) (not only ones they personally
created), but can't touch another Manager's account, and can't touch anyone outside their own
warehouse(s) even if the role would normally qualify. Nobody — including Admin — can deactivate
their own account.

There's no invite-link/email flow. Whoever creates an account sets its password directly, the same
way Company registration already works — the new user is told their login ID and password
out-of-band (in person, over chat, however the client normally shares this) and logs in with it
immediately.

**Everyone can edit their own name and password** once logged in, regardless of role. Two things
stay off-limits even on your own account: you can never change your own role (so nobody, Admin
included, can accidentally demote themselves out of the only admin seat), and your login ID is
locked in permanently once your account is created — it anchors your KPI history going forward.

**Onboarding a large batch of Operators?** User Master has the same bulk Excel import as the other
Master Data pages — useful once a Manager or Supervisor needs to add dozens of Operators at once
rather than one at a time. It follows exactly the same rules as adding someone by hand: you can
only import a role you're allowed to create, into a warehouse you yourself have access to.

**Every login is now recorded**, permanently — the User Master list shows how many days an account
has existed ("Days Active"), and clicking "Last Login" expands the row into that person's full
login history (most recent 100). This is first-level capture plus a quick-look viewer: the raw
history and a way to browse it both exist, but the actual manpower-attendance report (a proper
daily attendance view built from this data) is a next step, not built yet.

## What each role can see

| | Company Admin | Warehouse Manager | Warehouse Supervisor | Operator |
|---|---|---|---|---|
| **Warehouse Master** | All warehouses | Own warehouse(s) only | Own warehouse(s) only, view-only | No access |
| **Customer Master** | All customers | Only customers with a ship-to linked to their own warehouse(s)* | Same as Manager, view-only | No access |
| **SKU Master** | Full catalog | Full catalog | Full catalog, view-only | No access |
| **User Master** | Everyone in the company | Themself + anyone sharing a warehouse with them | Same as Manager | No access |

\* A customer whose ship-to address isn't linked to a specific warehouse yet stays invisible to
Manager/Supervisor until an Admin (or a Manager who covers that warehouse) links it — a deliberate
safety default rather than showing it to everyone by default.

**Why SKU is different**: a SKU isn't owned by one warehouse — the same product can move through
several — so restricting it per-warehouse wouldn't make sense. Warehouse and Customer data *is*
naturally warehouse-specific (this is also the privacy boundary: staff at one warehouse shouldn't
see another warehouse's 3PL/customer details).

## What each role can edit

Same shape as visibility, minus one more restriction: **Supervisor never gets edit rights**, only
Manager and Admin can create/edit Warehouse, Customer, and SKU records. Deleting a record (or
"Delete All") is tighter still — Admin only, Manager included, everywhere.

| | Company Admin | Warehouse Manager | Warehouse Supervisor | Operator |
|---|---|---|---|---|
| Create / edit master data | Yes | Yes, within their scope | No (view-only) | No |
| Delete a record / Delete All | Yes | No | No | No |

## Login

- Company Admin and Warehouse Manager accounts log in with a real email address.
- Warehouse Supervisor and Operator accounts log in with any unique ID (e.g. `AAA`, `BBBB`) —
  shop-floor staff often don't have a work email, so this isn't required for them.
- Every login (email or ID) is guaranteed unique across the whole system, which is what makes
  per-person KPI tracking possible later — two people can never share a login.

## The "Function Tag" field

When creating a Supervisor or Operator, there's an optional free-text tag — e.g. "Inbound Sup",
"Shift Sup", "Picking", or one combined tag for a company that doesn't split these roles. This is
descriptive only, for future KPI reporting and task routing — it doesn't change what that person
can see or do today. Real per-function access differences (an Inbound Supervisor seeing different
things than an Outbound Supervisor) are a deliberately separate, not-yet-built phase.

## What's deliberately not built yet

- **A client-configurable permission system.** Everything above is a fixed rule, the same for
  every client company. A toggle-based system letting each client adjust these rules themselves
  was discussed and intentionally deferred — worth revisiting once it's clear which rules actually
  need to differ client-to-client, rather than building a settings screen nobody ends up using.
- **Network-restricted logins** for ID-based (Supervisor/Operator) accounts — e.g. only usable on
  the client's own warehouse network. No such infrastructure exists yet.
- **Zone-level task assignment** ("assign this pick to an operator in my zone") — depends on the
  Locations/Bins module, which hasn't been built yet.
- **Super Admin account creation** — still no controlled way to create the platform-level role.

## How this has been tested

Every rule above was exercised end-to-end against a disposable, throwaway test company (never
real data) — both the "should work" and "should be denied" side of each rule: creation hierarchy,
warehouse-scoped visibility for Warehouse/Customer/User, unscoped SKU visibility, read-only
enforcement for Supervisor, zero visibility for Operator, cross-warehouse denial, self-deactivation
denial, and the email-vs-ID login rule. 37 checks, 37 passing, 2026-08-24.

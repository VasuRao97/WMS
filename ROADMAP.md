# WMS Roadmap

A forward-looking plan — what's shipped, what's next, and what's deliberately parked. `CLAUDE.md`
is the detailed build log (what got built, how, and why); this is the plan-level view for deciding
what to pick up next. Updated as priorities shift — last updated 2026-08-27 (Inbound deep-dive).

Stated direction: cover the basics of every module first (module build order below), then come
back and deepen each one — rather than gold-plating one module before the rest exist at all.

## Module build order — where we are

Master Data → Yard & Gate → **Inbound** → Putaway → Inventory → Outbound → Picking → Dispatch →
Returns → Analytics

| Module | Status |
|---|---|
| Master Data (Warehouses, SKUs, Customers, Locations, Users) | ✅ Built |
| Yard & Gate Management | ✅ Built (basics + one competitor-research pass) |
| **Inbound** | ✅ Basics built + one deep-dive pass — order maker (+ Excel bulk import), order matching, scan-based receiving, Complete Inward Process/Dock Out |
| Putaway | ⬜ Not started — schema exists (`PutawayTask`), no logic/UI |
| Inventory | ⬜ Not started — no live on-hand stock view exists anywhere yet |
| Outbound | ⬜ Not started — schema exists, no logic/UI |
| Picking | ⬜ Not started |
| Dispatch | ⬜ Not started |
| Returns | ⬜ Not started |
| Analytics | ⬜ Not started (deliberately last, built on top of everything else) |

## Session note (2026-08-27, Inbound deep-dive)
Rather than starting the next module, this session went deeper into Inbound per your own ask.
Three pieces landed: **Excel order import** (real, one file can create multiple orders — an
alternative to ERP push), **`DockLocationDistance`** (schema only — Dock × Location × distance in
meters, your own call to go with the most granular option; the actual "which dock minimizes
movement" algorithm is deliberately deferred until Putaway/Picking exist to consume it), and
**Gate & Yard's "Currently Open" table now visibly splits into Unload vs. Load** (a visibility
change over already-existing purpose-based logic, not new workflow — the real Outbound module
itself is still not started). Full detail in `CLAUDE.md`'s "Inbound deep-dive" section.

**Same-day follow-up**: closed a real gap you caught right after — Match Order used to trust a
typed PO/Invoice number with no check it was even the right vehicle. Every order now **requires a
Vehicle** at creation (manual + Excel import), a vehicle can only have **one open order at a
time**, and Match Order **auto-finds by vehicle** — no typed reference number at all anymore. See
CLAUDE.md's "Inbound order ↔ Vehicle 1:1 mapping" section.

**Second same-day follow-up, from your own live testing**: three more real gaps fixed — **Dock In
now requires an assigned dock** (was practically impossible before, now blocked with a clear
error), **each Dock Door can carry its own default staging Location** (new "Dock Doors" page under
Masters — the first frontend this ever had — Match Order pre-fills from it), and **approving a
blocked scan against a barcode that's registered to a DIFFERENT SKU is now hard-blocked** (a
genuinely unrecognized barcode's override still works exactly as before). A fourth item — an
active notification telling security it's time to Gate Out — is flagged but **NOT built**; you
asked to think through the fuller logic (documentation/paperwork time after dock-out, before gate
out is actually allowed) next session. See CLAUDE.md's "Live-testing follow-up" section.

The three candidates below are unchanged and still the live options for the next module-level
session.

## Immediate candidates for the next session

Pick one — these are the live options on the table, not a forced order:

1. **Putaway** — the natural next module. Moves received stock from its staging location to a real
   final storage bin. This is also what would let received Inbound stock actually go somewhere
   instead of sitting at staging indefinitely. Also the first real consumer of the new
   `DockLocationDistance` data (dock-suggestion logic was explicitly deferred to land here).
2. **Inventory (basic on-hand view)** — there is currently *no screen anywhere* to see "what's on
   hand at Location X." The ledger (`StockMovement`) has real data in it now (Inbound receiving
   writes to it), but nothing renders it. Even a read-only view would close a real, felt gap.
3. **Outbound order maker** — the flow you described in an earlier conversation (destination +
   vehicle capacity check, weight *and* volume, triggering a pick list) — a real, well-understood
   need, but benefits from Inventory existing first so a "can this order be fulfilled" check means
   something. Would also be the first real user of the Gate & Yard "Vehicles to Load" queue added
   this session.
4. **Dock-out → Gate-out signal** — your own explicit ask, promised for "next session": an active
   notification telling security a vehicle is ready to Gate Out, plus real logic for the fact that
   paperwork/documentation still takes time after dock-out before Gate Out can actually happen.
   Needs a real design conversation first (touches similar territory to the still-fully-deferred
   Dock Scheduler) — not a quick toggle.

## Deferred, lower priority (per your own explicit calls — don't build unprompted)

- **Self-service driver check-in** (`SelfCheckInRequest`, schema-only) — flagged as a top Yard/Gate
  gap in competitor research, still "later we do it."
- **Yard Plan View** — needs a small spatial-layout design pass first (Yard Slots have no
  row/aisle data today).
- **ERP push for Inbound orders** (`Company.allowErpInboundPush`) — manual order maker + Excel bulk
  import only for now, by design; ERP push reuses the same backend logic once built.
- **`DockLocationDistance` data-entry tooling** (no endpoint/import/UI exists yet) and the actual
  dock-suggestion algorithm that reads it — both deliberately deferred until Putaway/Picking exist
  to consume the data (your own call, 2026-08-27).
- **Real GS1/unique-barcode parsing** ("Reading B") — the tyres/FMCG-case problem. Today's
  Supervisor-approve fallback makes those categories usable without this; full barcode-format
  parsing is a distinct, larger future feature.
- **Camera-based scanning** — hardware-scanner (keyboard-wedge) input works today; no
  camera/decode library wired up.
- **Real SMS/Email/WhatsApp/Voice providers** — every notification channel is still a stub that
  only logs. MSG91 (SMS/Email/WhatsApp) and Exotel (voice) were the research leads, neither chosen.
- **Dock Scheduling** (the real dock-selection algorithm) — still zero design/schema; only its
  future *output* (a dock number) has anywhere to land today.
- **Blacklist enforcement at Gate In**, **analytics dashboard**, **WMS/TMS integration** —
  explicitly parked by you; don't propose as quick wins.
- **`SUPER_ADMIN` account creation**, a **configurable permission matrix**, a real **company-admin
  invite-link flow**, **Inventory Control Policy** (min/max, reorder point, FIFO/FEFO/LIFO),
  **Opening Balance load**, **dispatch-proximity distance calculation**, real **SAP/ERP
  integration**, **cloud/production deployment** — all still fully deferred, no schema/design work
  done.

## How to use this file

At the end of a session, update the module status table and the "immediate candidates" list before
committing — that's what keeps this useful for picking up work cold in a new session, instead of
re-deriving it from `CLAUDE.md`'s full chronological history each time.

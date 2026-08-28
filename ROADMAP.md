# WMS Roadmap

A forward-looking plan — what's shipped, what's next, and what's deliberately parked. `CLAUDE.md`
is the detailed build log (what got built, how, and why); this is the plan-level view for deciding
what to pick up next. Updated as priorities shift — last updated 2026-08-28 (Dock Door
auto-generation rebuild; Putaway itself still not started).

Stated direction: cover the basics of every module first (module build order below), then come
back and deepen each one — rather than gold-plating one module before the rest exist at all.

## Module build order — where we are

Master Data → Yard & Gate → **Inbound** → Putaway → Inventory → Outbound → Picking → Dispatch →
Returns → Analytics

| Module | Status |
|---|---|
| Master Data (Warehouses, SKUs, Customers, Locations, Users) | ✅ Built |
| Yard & Gate Management | ✅ Built (basics + one competitor-research pass) |
| **Inbound** | ✅ Basics built + two deep-dive passes — order maker (+ Excel bulk import + real ERP push), order matching, scan-based receiving, Complete Inward Process/Dock Out |
| Putaway | ⬜ Not started — schema exists (`PutawayTask`), no logic/UI. Prerequisite closed 2026-08-28 (Dock Door + staging Locations now auto-generated from Warehouse.noOfDocks) |
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

**Third same-day follow-up**: a design conversation about a Dock + Staging + Yard visualizer
(same spirit as the Locations Plan View) got started, then explicitly paused mid-conversation —
"no more joining in depth for now." **Nothing decided, nothing built.** Pick this up by re-asking
these exact four questions before touching anything:
1. Dock Doors and Yard Slots have zero positional data today (just a code string, no row/sequence)
   — add a simple staff-typed position number to each (cheap, matches this project's flankNumber/
   Section convention), or something fuller?
2. Should the diagram show live occupancy (which vehicle is at which dock/slot right now — all the
   data for this already exists) or just a static structural layout (mirroring the Locations Plan
   View's original v1 scope)?
3. Where should it live — on Gate & Yard near Yard Status (where the live tracker data already is),
   or a new standalone page?
4. Should a dock's default staging location (built this session) be visually connected to the
   existing Locations Plan View, or just shown as a text label?

Also researched (not built, not decided) this same session: a web-research pass on other WMS
platforms' Inbound modules (Blue Yonder, Manhattan Associates, general industry sources) surfaced
two gaps that keep resurfacing independently across sources — **closing a short receipt** (a
partially-received order has no way to leave `PARTIALLY_RECEIVED` today if the shipment was
genuinely short — every vendor treats a formal discrepancy close-out as standard) and **batch/lot
+ expiry capture at receiving** (feeds a future FEFO policy). Both were already on the very first
"list down all features" round of this Inbound deep-dive and weren't picked then — they're showing
up again on their own, worth a real look next time Inbound comes up. Sources, for reference:
[Cleverence — WMS Receiving](https://www.cleverence.com/articles/business-blogs/wms-receiving-3846/),
[Blue Yonder WMS — Concentrus](https://concentrus.com/blue-yonder-wms/),
[Manhattan Active WMS — ERP Research](https://www.erpresearch.com/erp-add-ons/wms/manhattan-active-wms),
[S2B Analytics — Dock-to-Stock](https://s2bianalytics.com/warehouse-receiving-process/). Nothing
from this research pass is written into `CLAUDE.md` — this note here is the only record of it.

## Session note (2026-08-27, ERP push — a later, separate session)
You asked directly: since there's no ERP actually connected, what should "ERP push" even mean?
Landed on a real distinction — the *ingestion endpoint* is provider-agnostic and buildable now
(it's our own contract, any ERP's adapter maps to it later); the *specific integration* (payload
shape, auth handshake) genuinely isn't, and stays untouched. Built the first half: **`POST
/erp/inbound-receipts`**, authenticated by a per-company API key (generate/regenerate it from
Company Settings' new "ERP Integration" section), resolved by Warehouse/SKU's own internal Code
(not `erpCode` — checked, and that field is completely unwired anywhere in this codebase, no form
sets it even for SKU/Warehouse). Deliberately does **NOT** require a Vehicle at creation — your own
call: "ERP will never know about vehicle type etc, its completely a WMS thing... the PO from ERP is
pushed to this order maker where the vehicle details are then added" — so a new **Assign Vehicle**
action on Inbound Orders' "All Orders" table completes a vehicle-less order once staff know which
truck it's on. Full detail in `CLAUDE.md`'s "ERP push" section.

## Session note (2026-08-27, picking up Putaway)
Two Inbound-adjacent items from the research pass got resolved: **closing a short receipt** stays
deferred (noted below), and **batch/lot + expiry capture** isn't dropped, just relocated — your own
call: this system has no concept of inventory *age* anywhere yet, and that's really an Inventory
master-file design question, not something to bolt onto Inbound scanning in isolation. Revisit it
when Inventory gets designed, not before.

**Putaway is next**, picked directly off the current state: material has reached staging (Inbound
receiving works end-to-end) with nowhere further to go — the real, felt gap the module build order
was always pointing at anyway.

## Session note (2026-08-28, Dock Door concept rebuilt, Putaway not yet started)
The "confirm real Dock Door staging config" item above turned into something bigger: checking the
dev database directly found no company clearly identifiable as "the real client tenant" (~50
companies, all reading as this project's own test/throwaway data) — the client confirmed they're
not sure either. Rather than chase that further, the client changed the underlying concept: **Dock
Doors and their staging Locations are no longer manual master data at all.** `Warehouse.noOfDocks`
(now required at creation) is the sole input; every Dock Door plus its own Inbound
(`Dock{N}-SA-IB`)/Outbound (`Dock{N}-SA-OB`) staging Location pair is created automatically,
append-only, the moment a warehouse is set up — "i dont want the client doing this activity at all,"
the client's own words. A new rule was also built: only one of a dock's Inbound/Outbound staging
bins can be in use at a time (enforced via real on-hand stock at Match Order) — ready for the
still-unbuilt Outbound module. Full detail in `CLAUDE.md`'s "Dock Door + staging Locations now fully
auto-generated from Warehouse.noOfDocks" section. **Putaway itself has NOT been started yet** — this
was a prerequisite closed first, the three workflow-alignment questions (task creation trigger, bin
selection, page location) are still open and unanswered.

The first three candidates below are the module-level options (unchanged from before); the rest
are smaller items raised in earlier sessions — pick any of them, not a forced order.

## Immediate candidates for the next session

Pick one — these are the live options on the table, not a forced order:

1. **Putaway — picked, in progress.** The natural next module. Moves received stock from its
   staging location to a real final storage bin. This is also what would let received Inbound
   stock actually go somewhere instead of sitting at staging indefinitely. Also the first real
   consumer of the new `DockLocationDistance` data (dock-suggestion logic was explicitly deferred
   to land here). `PutawayTask` schema already exists (receiptLine/sku/from/to Location/quantity/
   status PENDING|COMPLETED) — no logic/UI built yet, workflow conversation to happen first.
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
5. **Dock + Staging + Yard visualizer** — raised this session, paused mid-conversation before any
   decisions were made. Same spirit as the Locations Plan View. Needs a real spatial-data pass
   first (Dock Doors/Yard Slots have no position/sequence data today) — see the four open questions
   in the session note above before building anything.

## Deferred, lower priority (per your own explicit calls — don't build unprompted)

- **Self-service driver check-in** (`SelfCheckInRequest`, schema-only) — flagged as a top Yard/Gate
  gap in competitor research, still "later we do it."
- **Yard Plan View** — needs a small spatial-layout design pass first (Yard Slots have no
  row/aisle data today).
- **Closing a short receipt** — a partially-received order has no way to leave
  `PARTIALLY_RECEIVED` today if the shipment was genuinely short. Flagged by both this project's
  own feature list and independently by web research on other WMS platforms — every vendor treats
  a formal discrepancy close-out as standard. Explicitly deferred, 2026-08-27.
- **Batch/Lot + expiry capture** — this system has no concept of inventory *age* anywhere yet.
  Deliberately NOT tackled as an Inbound-scanning add-on — your own call: revisit this when the
  Inventory master file gets designed, since age/lot tracking is really an Inventory-level concern
  that picking (FEFO) logic will need, not something to bolt on in isolation now.
- **`erpCode`-based resolution for ERP push** — ERP push (built 2026-08-27) resolves orders by
  Warehouse/SKU's own internal Code for now, since `erpCode` is completely unwired anywhere (no
  form sets it, not even for Sku/Warehouse). A real fast-follow once erpCode actually gets a UI —
  small, not urgent.
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

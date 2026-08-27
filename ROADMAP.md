# WMS Roadmap

A forward-looking plan — what's shipped, what's next, and what's deliberately parked. `CLAUDE.md`
is the detailed build log (what got built, how, and why); this is the plan-level view for deciding
what to pick up next. Updated as priorities shift — last updated 2026-08-27.

Stated direction: cover the basics of every module first (module build order below), then come
back and deepen each one — rather than gold-plating one module before the rest exist at all.

## Module build order — where we are

Master Data → Yard & Gate → **Inbound** → Putaway → Inventory → Outbound → Picking → Dispatch →
Returns → Analytics

| Module | Status |
|---|---|
| Master Data (Warehouses, SKUs, Customers, Locations, Users) | ✅ Built |
| Yard & Gate Management | ✅ Built (basics + one competitor-research pass) |
| **Inbound** | ✅ Basics built — order maker, order matching, scan-based receiving, Complete Inward Process/Dock Out |
| Putaway | ⬜ Not started — schema exists (`PutawayTask`), no logic/UI |
| Inventory | ⬜ Not started — no live on-hand stock view exists anywhere yet |
| Outbound | ⬜ Not started — schema exists, no logic/UI |
| Picking | ⬜ Not started |
| Dispatch | ⬜ Not started |
| Returns | ⬜ Not started |
| Analytics | ⬜ Not started (deliberately last, built on top of everything else) |

## Immediate candidates for the next session

Pick one — these are the live options on the table, not a forced order:

1. **Putaway** — the natural next module. Moves received stock from its staging location to a real
   final storage bin. This is also what would let received Inbound stock actually go somewhere
   instead of sitting at staging indefinitely.
2. **Inventory (basic on-hand view)** — there is currently *no screen anywhere* to see "what's on
   hand at Location X." The ledger (`StockMovement`) has real data in it now (Inbound receiving
   writes to it), but nothing renders it. Even a read-only view would close a real, felt gap.
3. **Outbound order maker** — the flow you described in an earlier conversation (destination +
   vehicle capacity check, weight *and* volume, triggering a pick list) — a real, well-understood
   need, but benefits from Inventory existing first so a "can this order be fulfilled" check means
   something.

## Deferred, lower priority (per your own explicit calls — don't build unprompted)

- **Self-service driver check-in** (`SelfCheckInRequest`, schema-only) — flagged as a top Yard/Gate
  gap in competitor research, still "later we do it."
- **Yard Plan View** — needs a small spatial-layout design pass first (Yard Slots have no
  row/aisle data today).
- **ERP push for Inbound orders** (`Company.allowErpInboundPush`) — manual order maker only for now,
  by design; this reuses the same backend logic once built.
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

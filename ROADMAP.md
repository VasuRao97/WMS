# WMS Roadmap

A forward-looking plan — what's shipped, what's next, and what's deliberately parked. `CLAUDE.md`
is the detailed build log (what got built, how, and why); this is the plan-level view for deciding
what to pick up next. Updated as priorities shift — last updated 2026-09-06, next session: **the
FMS×ABC combined-classification study** (see "Immediate candidates" below) — the client's own
stated next topic once Ground/Floor Putaway was fully aligned. Most recently, same day: the client
saw the Ground box-width-scaling fix live and correctly pushed back — "how is this 4x4? looks like
1x4... dont keep your rack as ideal, we need to align separately." **Ground/Floor's Plan View was
properly rebuilt as a result**: each COLUMN now renders as its own row (exactly like a Rack bay
already does — not a shortcut, but the real physical equivalence Ground's own schema was built
around, since `Location.rack` is deliberately reused as the column number sharing the same LIFO
meaning `depth` already has with Rack), with Depth splitting into real side-by-side boxes within
each row the same way Rack's own multi-deep lanes already do. A 4×4 bin now genuinely renders as a
4-row×4-box grid (16 individually visible, individually clickable positions) in both 2D and 3D,
instead of one stretched or width-scaled box. See CLAUDE.md's "Locations/Bins: a real flankNumber
collision bug, Ground box size parity, and a hard guard rail" section (the same-day follow-up
subsection) for the full detail. Before that, same day: a real client bug report ("generated ground
storage locations in tnr8, can't find them") traced to SPR and Ground/Floor both being generated
under Aisle "1" by mistake, which corrupted their flankNumbers — fixed the generator bug,
**backfilled `TNR8`'s ~480 already-corrupted Ground rows to fresh, non-colliding flank numbers
(client's explicit go-ahead)**, and — the client's own direct follow-up question, "should we say NO
if someone tries to superimpose 2 storage types?" — added a real hard guard rail:
`create()`/`generate()`/`bulkImport()`/`update()` now all refuse to write a Location into an Aisle a
conflicting storage-type family already occupies (same Rack sub-types still freely mix, only a
genuine cross-family clash like Rack vs. Ground/Floor is blocked), with existing rows whose Aisle
isn't changing correctly grandfathered so this can't break `TNR8`'s own now-legitimate coexistence.
Before that, same day: **the
Putaway Simulation sandbox now supports Ground/Floor as a selectable storage type** — "can we have a
simulator now for ground?" — closing the last gap in the sandbox's storage-type coverage
(SPR/Drive-in/ASRS already worked). Investigating this surfaced and fixed two real, pre-existing
Plan View bugs left over from the 2026-08-24 Ground rewrite (one row per real column×depth position,
not one aggregate row per block) — a stale 2D box label reading one arbitrary row's own depth
instead of the whole block's, and a genuine 3D overlapping-boxes bug (every position in one Ground
block used to render stacked exactly on top of each other). Both fixes live in the shared Plan View
components, so the real Locations page benefits too, not just Simulation. See CLAUDE.md's "Putaway
Simulation" section (the Ground/Floor follow-up subsection) for the full build/verification detail.
This closes out the Ground/Floor Putaway build entirely, simulator included. Earlier the same day:
**Ground/Floor Putaway — real logic built and verified**, kept deliberately separate from Rack's own
(`suggestRackBin()`/`suggestGroundBin()` are two independent methods, not one shared function with
storageType branches — your own explicit ask mid-build: "keep all logic for different storage type
separate, like ground is sep, rack is sep"). Picked ahead of Inventory and the FMS×ABC study on a
real argument (Inventory's gap is a missing convenience since on-hand data is already derivable
elsewhere; Ground/Floor's is a missing *capability* — `suggestBin()` returned `NEEDS_BIN`
unconditionally for that storage type, no workaround, and the gap had been independently re-flagged
three separate times before finally getting tackled). A full design conversation settled the
physical model (a bin subdivides into single-file LIFO "columns," mechanically identical to a Rack
lane just laid flat), a genuinely new column-lifecycle rule (closed to new putaway once picking
starts on it, until fully empty — feeding the still-unbuilt reslotting engine), and per-class
`respectsColumnBoundariesA/B/C/D` toggles (the client's own explicit ask — "give the flexibility to
A B C D"). Also closed a real, unrelated gap discovered along the way: `WarehouseStorageType.
maxSkusClassA/B/C` had been completely dead (no UI ever set it) since 2026-08-24 — now has a real
Company Settings mini-editor covering BOTH Rack and Ground/Floor, the first UI either family has
ever had for it. **Ground/Floor Putaway is now fully built end to end** — schema (`dd05b81a`), logic
(`68c1edbd`), and the settings UI (`949ff4d9`) all shipped and verified the same day. Verified via a
throwaway-company script (21/21) for the logic, catching and fixing one real bug along the way
(free-mixing mode was checking "no stock of this SKU" instead of "no occupant at all," which would
have let two SKUs collide on the same position), plus a full live-browser pass for the settings UI
(warehouse + storage-type-row pickers, save, reload, direct API check — all confirmed persisting
correctly). Full design and verification trail in the `wms-putaway-design` memory. **Next: the
FMS×ABC combined-classification study**
(candidate #2 below) — the client's own stated next topic, and Ground's own bin-selection logic is
deliberately shipping with a placeholder pending that exact study. Before this, same day: a
deliberate **hardening pass** (line-by-line correctness/performance review, not a new module) —
`suggestBin()` rebuilt to avoid several full-map rescans on its hottest path, two real race
conditions closed (Simulation's SKU pool, Pallet's scan-time load resolution), 9 missing DB indexes
added across the tables that grow fastest, and the frontend bundle split so a login no longer
downloads all 17 pages (plus Three.js) in one ~1.4MB chunk. See the git history / commit
`e1744b7d` for the full detail — nothing to build further here, this was cleanup, not scope. Same
day: a new to-do was raised, not yet designed — **combining ABC classification with a new FMS
(Fast/Medium/Slow-moving) axis for exact material putaway logic** — added to the "Immediate
candidates" list below and to the `wms-abc-velocity-design` memory. Just before the hardening pass,
same day: **the "Rows 1-N"
row-position summary is built** — closes a loose end from earlier the same session (Simulation's
Plan View: "1 being the start and last number being the last"). Each flank's existing `R{n}` callout
now has a second, smaller line under it counting positions the same way this view already pairs
rows (by position, not raw stored number) — shows on the real Locations Plan View too, since it's
the same shared component Simulation reuses. See CLAUDE.md's "Plan View: 'Rows 1-N' row-position
summary" section. Just before that, same day: **dock-relative Putaway
placement (Topic 2) is built and verified**, right after Topic 1 — a new `WarehouseDockZone` config
(0-2 zones per warehouse, capturing which end of the aisle order sits near an Inbound/Outbound/Both
dock) now drives `suggestBin()`'s placement of fast (A/B) vs. slow (C/D) movers, replacing today's
arbitrary flank-number-only proxy the moment a warehouse configures it, with a proven fallback to
the old behavior when it doesn't — live-verified to genuinely flip direction between a U-shape and
I-shape configuration. Also wires Topic 1's computed `SkuWarehouseClass` into real placement
decisions for the first time (overriding a stale manual/imported class). New Company Settings "Dock
Configuration" mini-editor. See CLAUDE.md's "Dock-relative Putaway placement — Topic 2" section and
the `wms-abc-velocity-design` memory for the full detail. Just before that, same day: **ABC velocity
reassessment (Topic 1) built and verified** — a real monthly job re-derives each SKU's A/B/C/D class PER
WAREHOUSE (not company-wide) from its own actual trailing dispatch quantity, replacing blind trust in
a manually-typed/imported class. A new standalone "ABC Classification" nav page plus a Company Settings
section (enable toggle, configurable A/B/C cutoffs, assessment window) round it out. See CLAUDE.md's "ABC
velocity reassessment" section for the full detail. Earlier
the same day: **Plan View backlog items 2 and 3 are done** — a per-company "Allow Putaway location override" toggle (Company Settings)
lets an operator complete a trip at a different real, active bin instead of today's hard block, and
any such mismatch now surfaces as a discrepancy — a `⚠` flag on the task queue row, plus a dedicated
Supervisor+ "Discrepancies" list with a Mark Reviewed action. Only backlog items 1 (Yard spatial
schema) and 4 (Docks/Staging visual) remain. See CLAUDE.md's "Putaway location override +
discrepancy highlighting" section for the full build/verification detail. Earlier the same day: **a
Putaway Simulation sandbox is now built and verified** — a dedicated sandbox warehouse running the real, unmodified
`suggestBin()` algorithm against auto-generated synthetic SKUs, replayed as a speed-adjustable
step-by-step animation through the existing 2D/3D Plan View. A tangent off the Plan View backlog
below, not one of its numbered items. Caught and fixed a real race condition in the sandbox's lazy
first-time setup along the way (see CLAUDE.md — `upsert`/`skipDuplicates` beat `findFirst`-then-
`create` once two callers can race, and React StrictMode is a real source of that race in dev). Pick
Face re-slotting simulation (the same sandbox idea applied to the other algorithm) is the deferred
next phase. Previously, 2026-09-05: **3D's Plan View gained
camera auto-focus** (backlog item 4) — checking an aisle now smoothly flies the camera to fit
whichever aisle(s) are selected, back to the full warehouse when none are. Caught and fixed a real
`useFrame` stale-closure bug along the way (see CLAUDE.md for the full story — a ref updated during
render, not an effect, is the fix). Same day, earlier: **2D's Plan View gained a Level toggle**
(backlog item 3) — narrows the view to exactly one real Level instead of the usual collapsed
level-range box, by filtering which rows feed the existing box-builder (no new rendering path). Same
day, earlier still: **2D's Plan View gained click-to-inspect** (backlog item 2, 3D
already had it) — a shared `DetailPanel` component now used by both views. Same day, earlier still:
**the Locations/Bins Plan View gained an occupancy overlay** — two new color modes, By Category and By A/B/C Class, both
driven from real `StockMovement` data (a new `GET /locations/occupancy` endpoint), applied to both
the 2D and 3D views alongside today's default storageType coloring. First item off a real "upgrade
mode" backlog for the Plan View. Same day, earlier: **the Locations/Bins Plan View gained a real 3D
mode** — a real WebGL camera via Three.js/React Three Fiber, showing the WHOLE warehouse by default
as simplified per-aisle footprint blocks, with a checkbox "slicer" to swap one or more aisles into
full per-bin detail in place (unselected aisles stay visible for spatial context), plus
click-to-inspect — alongside the existing top-down 2D view. The first genuinely visual/3D feature
and the first new rendering dependency in this codebase. 2026-09-02:
**Putaway now has a
real operator-assignment fairness layer** (live "who goes next" recommendation + Supervisor/Manager
escalation, oldest-staged-stock priority signal) — **the real Analytics module has begun**
(operator productivity at the Pallet level, split per operator, plus abandoned-claim flagging) —
and **Drive-in bin suggestion now has its own strategy, split from SPR/ASRS** (whole-column absolute
single-SKU, deepest-tier-first/bottom-up fill). See the session notes below. 2026-09-01: Pallet
consolidation ("marrying" loose cases onto a pallet before
Putaway) built and live-verified, from the closed design the 2026-08-31 session further down left
ready. See CLAUDE.md's matching sections for full build detail and the `wms-putaway-design` memory
for the complete design-to-build trail.

## Session note (2026-09-06, same session — Plan View "Rows 1-N" row-position summary)
Closes the loose end flagged at the end of the Topic 2 note below — the very first ask from earlier
this same session, picked back up once both ABC topics concluded: "we need to have start row number
and finish row number so we know it in the layout, 1 being the start and last number being the
last." Scoped at the time to Simulation's Plan View, "a 'Rows 1-8' summary near each flank header."

**Built**: each flank's existing `R{n}` callout in `LocationsPlanView.tsx` now has a second, smaller
"Rows 1-N" line under it — a position count (1 nearest the corner, N farthest), not the raw stored
rack/block numbers, consistent with this view's own "rows pair by position" rule. Shown at both the
top and bottom of each column (mirrored, same as the R{n} callout itself). Shows on the real
Locations Plan View too, not just Simulation — it's the exact same shared component. 2D-only; 3D
already shows each position as a real object in space.

Verified live through Simulation's real UI (throwaway company `ROWSCHK1`): the default 3×3×3 sandbox
showed "Rows 1-3" everywhere; setting Length to 8 and re-running correctly showed "Rows 1-8"
instead, confirmed via direct SVG text-node inspection (each `<text>` element's own `y` position, not
just page text). See CLAUDE.md's matching section for full detail.

## Session note (2026-09-06 — ABC velocity reassessment, Topic 1 of 2)
Two topics raised together, deliberately sequenced by explicit client instruction: "lets finish topic
1 first then go into topic 2. pls note." This note covers Topic 1 only.

**The trigger**: "i wont believe the import ABC class, as it can be a one time master dump for the
client, but we have to check the regular monthly dispatches (trailing 3 months) and re-access the ABC
SKUs for each category." A real monthly job now re-derives each SKU's class from actual dispatch
velocity instead of trusting whatever was typed in or Excel-imported.

**The one design fork worth stopping to confirm**: warehouse-scoped, not company-wide — settled by the
client's own example, "in kashmir you wont set coke a lot? but its A item you might sell minuite maid
the most... lets keep it warehouse level." Verified for real: the exact Kashmir/Chennai scenario,
reproduced with real data, correctly classified Minute Maid as A in one warehouse and C in the other,
Coke the exact reverse.

**Built**: per-warehouse classification (`SkuWarehouseClass`, cumulative-%-of-dispatched-quantity
ranking, configurable 75/15/10 cutoffs), a real 4th class `D` for zero-dispatch SKUs ("3 months + no
sales"), a monthly cron (1st of the month, at night) plus an on-demand "Run Now," and a historical
dispatch bootstrap import (a genuinely separate `HistoricalDispatchSeed` table, not fake backdated
ledger rows — `StockMovement.locationId` is required and nobody actually knows a 2-month-old
shipment's real bin). New "ABC Classification" page plus a Company Settings section. See CLAUDE.md's
matching section for the full build/verification detail.

**Deliberately not built yet**: the daily reslotting/consolidation suggestion engine (points 5/6 —
"system should suggest which are available for re-slotting and which few bins/pallets can be
consolidated... every day system should push these changes so hygiene of inventory is high"). This
genuinely needs Topic 2's own placement rules to know what a good target bin even looks like — schema
is laid down ready, the algorithm itself waits for Topic 2 to conclude.

**Next (at the time)**: Topic 2 — dock-relative Putaway placement, picked up immediately after this
same day. See the session note directly below.

## Session note (2026-09-06 — dock-relative Putaway placement, Topic 2 of 2)
Picked up right after Topic 1, same session. The client rejected the first proposed approach
outright — a per-aisle manually-entered numeric proximity rank ("no no, not the right way") — and
redirected to researching real warehouse layouts first: "look internet on differant types of
warehouese." A WebSearch pass surveyed U-shape/I-shape/L-shape archetypes, leading to the accepted
design once explained with a concrete worked example ("cool, thats what we need!").

**Built**: new `WarehouseDockZone` (0-2 rows per warehouse — `purpose` Inbound/Outbound/Both +
`nearAisleEnd` Low/High, relative to the warehouse's own natural-sorted Aisle order, reusing an
existing convention rather than requiring a new per-aisle measurement). Confirmed: Outbound wins
("it should go to near the outbound end," even though Outbound/Picking doesn't exist as a module
yet), Outbound-proximity is the primary sort tiebreak ahead of Level, and Drive-in uses
"first-available" (no fixed per-column class reservation). `suggestBin()`'s candidate sort now goes
occupancyCount → Outbound-proximity → Level (SPR/ASRS only) → flankNumber (unchanged final
fallback, so an unconfigured warehouse behaves exactly as before). Also wires Topic 1's computed
`SkuWarehouseClass` into real placement for the first time — it now outranks a stale manual/imported
`Sku.abcClass` the moment it exists for a warehouse, closing the loop between the two topics. New
Company Settings "Dock Configuration" mini-editor (same "no general Warehouse Edit form" pattern as
Aging Methodology).

Verified via throwaway-company diagnostic scripts calling the real `suggestBin()` directly: a
U-shape (1 zone) and an I-shape (2 zones, opposite ends) on an otherwise IDENTICAL layout produced
genuinely REVERSED placement for the same SKUs — proof the direction actually flips with
configuration, not just a plausible-looking answer — plus a confirmed unconfigured-warehouse
fallback and the SkuWarehouseClass-override behavior. A second script confirmed Drive-in's
first-available column selection. Then re-verified live through the real Company Settings UI,
including a full page reload confirming persistence via the live DOM, not just in-memory state. See
CLAUDE.md's matching section and the `wms-abc-velocity-design` memory for full detail.

**Deliberately not built yet**: the daily reslotting/consolidation suggestion engine from Topic 1
is now genuinely unblocked (this was the placement-rule dependency it needed) but the actual
detect-and-suggest algorithm itself still isn't written. The A-vs-B same-bin-contention question and
the MHE-travel-time alternative to the flat level rule (both raised earlier in this same
conversation) remain open, not decided either way. Also still outstanding, unrelated to either
topic: the "start row number/finish row number" ask from earlier this same session (Simulation's
Plan View) was never built at the time this note was written — the conversation had pivoted to
velocity/placement without returning to it. **Closed later the same session** — see the "Rows 1-N"
session note above.

## Session note (2026-09-06 — Putaway Simulation: a sandbox to watch the real algorithm work)
The client's own question, a tangent off the Plan View backlog rather than one of its numbered
items: "can we have a simulation for me to check our visuals? which uses our algo/logic to fill in
racks... we will get to know how and whats happening." Scoped via clarifying questions before
building: synthetic data (not a real historical replay), the real Putaway bin-suggestion algorithm
first (Pick Face re-slotting simulation deferred to a later pass), step-by-step playback with speed
controls, a dedicated sandbox warehouse (never a real one), auto-generated SKUs.

**Built and verified**: one backend call (`POST /simulation/putaway/run`) runs the whole batch
server-side — a genuine call to the real, unmodified `suggestBin()` per unit, each followed by a
real `PUTAWAY_IN` movement so later steps see accurate occupancy — and returns the complete step
list for the frontend to replay client-side (instant speed/pause changes, no further network calls).
The sandbox is plain data (a well-known `SIM-SANDBOX` warehouse code, `SIM-`-prefixed SKUs), no new
schema. Reuses the existing 2D/3D Plan View components and occupancy-overlay color modes completely
unchanged. A real race condition in the sandbox's lazy first-time setup was caught and fixed
(`upsert`/`skipDuplicates` instead of `findFirst`+`create`) — see CLAUDE.md's "Putaway Simulation"
section for the full technical detail and verification trail.

**Follow-up, same session — Ground/Floor added**: "can we have a simulator now for ground?" —
`GROUND_FLOOR` joined the selectable Storage Types (SPR/Drive-in/ASRS already worked), with the
sandbox's layout generator mirroring the real `LocationsService.generate()`'s own column×depth
expansion. No changes needed to the actual simulation-running logic — it already worked unmodified
through `suggestBin()`. Investigating this caught and fixed two real, pre-existing bugs in the
shared Plan View components themselves (left over from the 2026-08-24 Ground rewrite, not new to
Simulation) — a stale 2D box label and a genuine 3D overlapping-boxes bug — both now fixed for the
real Locations page too. See CLAUDE.md's "Putaway Simulation" section (Ground/Floor follow-up
subsection) for the full detail.

**Next for this feature specifically**: Pick Face re-slotting simulation, the deferred phase 2.

## Session note (2026-09-05, same day — Plan View "upgrade mode": a full backlog, then item 1 built)
Right after the 3D Plan View shipped, the client asked to go into "upgrade mode" for the Plan View —
a proposed list of directions, then their own points added, closed into one backlog:

**Built this session**: item 1, occupancy overlay — By Category and By A/B/C Class color modes,
applied to both 2D and 3D. Item 2, click-to-inspect on 2D (3D already had it) — extracted a shared
`DetailPanel` component so both views show identical detail, not two copies. Item 3, a Level toggle
for 2D — narrows to exactly one real Level instead of today's collapsed level-range box, by
filtering which rows reach the existing box-builder (2D-only; 3D already shows real Levels
spatially). Item 4, camera auto-focus in 3D — checking an aisle (or several) smoothly flies the
camera to fit them, back to the full warehouse when none are selected; caught a real `useFrame`
stale-closure bug during verification (fixed via a ref updated on every render instead of an
effect). See CLAUDE.md's matching sections for full build/verification detail on each.

**Confirmed to build, not yet started** (in the order raised): Yard spatial schema only for now (no visual yet — groundwork for a future Yard
Plan View); and a Docks/Staging area visual (shape still to be worked out, its own conversation
when picked up).

**Built 2026-09-06** (see CLAUDE.md's "Putaway location override + discrepancy highlighting"): a
Putaway location-override toggle on Company Settings (any real, active bin is accepted, no
eligibility re-check, no reason required — frictionless, since the discrepancy record itself is the
audit trail) and discrepancy highlighting — a `⚠` flag on the task queue plus a dedicated
Supervisor+ "Discrepancies" list with a Mark Reviewed action, exactly the shape raised here.

**Already built, nothing more needed**: inactive-bin coloring (2D: grey/dashed; 3D: grey/
transparent) — raised as a new ask, turned out to already exist in both views.

**Declined/parked**: Zone Type coloring (not needed for now); Ground/Floor & Stillage sub-boxes
(developing Ground generally later); a separate utilization heatmap (covered by the occupancy
overlay above).

**Still genuinely open, not decided either way**: charts on Insights/Analytics — the alternative
"visualization" direction raised before 3D took priority, never explicitly confirmed or declined.

## Session note (2026-09-05 — Locations/Bins 3D Plan View, designed and built)
A genuinely new topic: "first we need to start with showing a 3d view... we need to give a toggle
to show 3d one also." The real gap: the existing top-down `LocationsPlanView.tsx` (2026-08-25)
collapses Level into text (`G+2`) — no way to see racks actually stacked vertically.

A visual mockup preceded the tech decision — two rendering styles (isometric/SVG vs. true 3D/WebGL)
were sketched side by side so the real tradeoff (cheap + fixed angle vs. a new dependency + free
camera) could be seen, not just described. Confirmed: **true 3D with a real camera**, via
`three` + `@react-three/fiber` + `@react-three/drei` (`OrbitControls`) — a first for this codebase,
proposed directly rather than silently added.

Click-to-inspect included (closing the original 2026-08-25 Plan View's own deferred item, landing in
3D first); occupancy overlay and Zone Type coloring explicitly confirmed OUT of scope for this pass,
not silently bundled in.

New `Locations3DView.tsx` reuses `LocationsPlanView.tsx`'s own grouping rules (flank/position/depth)
and its exported color map exactly — Level becomes a real Y position instead of text, Ground/
Stillage's dimensions become real box sizes instead of a text string.

**Same-day reconsideration**: "cant we just show the full warehouse first, then give slicers to
select which part of warehouse they want to check." A real fork, not a small tweak — clarified
"slicers" means Excel-style filter checkboxes (not a CAD clipping plane), confirmed unselected
aisles stay visible as simplified footprint blocks (keeping whole-warehouse spatial context) rather
than hiding, and confirmed multi-select (check several aisles into detail at once). The original
one-aisle-at-a-time scope's real reason (rendering every bin in a whole warehouse at once is a
genuine WebGL performance risk) is preserved via two levels of detail instead of dropped: every
aisle always renders as a plain labeled footprint block; checking it (or clicking the block itself)
swaps it into full per-bin detail in place. `LocationsPage.tsx` lost its own aisle dropdown — the
whole aisle-selection concern now lives inside `Locations3DView` itself.

Also same day: a solid floor plane added beneath the grid ("make the bottom look to be ground") —
the grid alone left empty white space showing through below it, reading as void rather than a
warehouse floor.

Verified live end-to-end at each step: a real generated SPR aisle rendered as 3 stacked-by-level
columns with the 2nd depth lane correctly offset behind (confirmed via screenshot); click-to-inspect
showed the correct Rack Name/code/Zone Type/Storage Type/Level/Depth; three real aisles (two
different SPR sizes + one Ground/Floor) rendered as correctly distinct-sized/colored/labeled
footprint blocks by default, and checking one correctly swapped it into detail while the others
stayed as footprints. `tsc -b` clean throughout. Full detail in `CLAUDE.md`'s "Locations/Bins: 3D
Plan View" section.

## Session note (2026-09-05 — Pick Face for SPR, designed and built same session)
A brand-new topic, not a Putaway extension: "we need to have a toggle at a warehouse level, if
pickface needs to be implemented or not." `LocationZoneType.PICK_FACE` had existed since the
Locations zone model was designed but never had real logic — invisible to both `suggestBin()` and
Insights' Storage Utilization report. Real-world shape, in the client's own words: "in SPR, usually
the bottom most position is left as pickface... all SKUs (mostly A+B) are accessible from the
bottom most position itself... when the pickface location is EMPTY for that particular sku, we
re-fill this location with another pallet of the same sku."

A genuine align-before-coding pass, not a rushed one — several rounds of `AskUserQuestion` surfaced
a much bigger design than "refill when empty": the SKU-to-slot assignment is **dynamic, never
fixed** ("keep on understanding which are the latest A class material [and] prioritize them into
the pickface"), and eviction is **proactive** — a still-occupied slot can be emptied early for a
higher-priority SKU, confirmed directly rather than assumed as the smaller "only refill empty slots"
option. A real code-level finding reframed the trigger question entirely: `MovementType.PICK` has
existed in the schema but has never been written anywhere — nothing in this system can currently
deplete a pick face location through real operation, since no Picking/Dispatch module exists yet.
Built anyway, dormant until then, same "schema/logic ready, unexercised until X" shape as Pallet
reuse-on-depletion.

**Confirmed shape**: `Warehouse.pickFaceEnabled` toggle (Company Settings, per-warehouse picker,
same home as Aging Methodology); the WHOLE bottom level of an SPR lane counts as pick face, not just
the front slot; a daily (not live) scheduled job, since eviction means real physical labor; tasks
auto-create and execute directly, no separate approval step; eviction respects strict class-tier
order only (A can evict B, B/C never evict each other, nothing evicts A) since `Sku.abcClass` is a
flat manually-typed tag with no velocity/recency data to break a same-class tie; a slot with no
eligible A/B candidate stays empty rather than falling back to C.

New `PickFaceTask`/`PickFaceTrip` models — deliberately NOT a `PutawayTask` variant, since
`PutawayTask.receiptLineId` is required and a pick face move has no receipt at all — mirroring
Putaway's own scan-driven claim/complete execution exactly. `PickFaceReplenishmentScheduler` reuses
`PutawayTasksService.suggestBin()` directly for eviction destinations, rather than a second copy of
the bin-suggestion logic. New standalone `PickFacePage.tsx`.

Verified via a throwaway-company diagnostic script invoking the real scheduler/service methods
directly against the dev DB (25/25) — covering cold-start REFILL (leanest-reserve-location
selection, C correctly excluded), idempotency across repeated runs, a real eviction (Class B
occupant evicted for a fresh Class A candidate, Class A never evicted), same-class never evicting,
and a `pickFaceEnabled: false` warehouse producing zero tasks through the real cron entrypoint —
plus a live browser pass through the actual Company Settings toggle and the new Pick Face page. Full
detail in `CLAUDE.md`'s "Pick Face for SPR" section; design conversation in the `wms-putaway-design`
memory. Still explicitly deferred: Pick Face for Drive-in/ASRS/Ground/Stillage, `Location.categoryId`
narrowing for candidate selection, and `PickFaceTrip` claim-expiry.

**Same-day follow-up**: asked directly whether Insights or Analytics needed to change now that Pick
Face is real. **Insights: left untouched** — its Storage Utilization report is about reserve rack
usage by class, a different concept from a pick face slot. **Analytics: extended** with a fourth,
separately-reported metric — Pick Face trip time per operator (grouped by task, not pallet, since a
`PickFaceTask` has no `palletLoadId`). Verified via a throwaway-company script (10/10) plus a live
browser pass. Full detail in `CLAUDE.md`'s Pick Face section, same-day follow-up.

## Session note (2026-09-02, same session — Putaway operator-assignment fairness)
Direct question: "when vehicle unloading is happening, we need to think on how/who assigns work to
the operators (unloading & putaway team), manual or auto." Reopened a 2026-08-28 decision (no
enforced dedicated-vs-pooled assignment, capture data instead) — the client's own reason to revisit
now: "yes, because now we have built the logic after that" (the Analytics module built earlier this
same session is exactly the data that decision was waiting on). Scoped to Putaway only — "lets
finish the putaway bit first" — unloading/Inbound deferred.

**Confirmed shape**: a live recommendation, not a hard task lock (an operator still scans whatever's
physically in front of them — no printed pick ticket exists to enforce a specific assignment).
Ranks free, MHE-capable operators by idle time; whoever's been free longest goes next. Two operator
capability flags (`canOperateMhe`/`canHandleGroundBlock`), both optional — "loader and picker should
not be same at big warehouses, but... small warehouses we dont need to calculate in such
granularity" — MHE side routes for real now, Ground/Block side is schema-only pending Ground/
Stillage's own Putaway logic. A real flaw in an early "drop the ignorer to the back of the queue"
idea got caught and fixed: "he is actually happy as he would be getting very less work to do" —
fixed via a timestamp-based re-rank instead of a literal last-place demotion. Escalation mirrors
Detention's own alert-then-escalate shape (Supervisor, then Manager), one company-configurable
grace period reused for both steps. And a real gap surfaced independently, confirming a previously-
flagged one: fair rotation alone doesn't stop an operator grabbing whatever's physically closest
while older stock waits — fixed by always naming the oldest staged stock as the priority alongside
whose turn it is.

Verified via a throwaway-company API script (18/18, including catching a real Postgres NULL-
comparison bug and — unusually for this project — actually waiting for the real per-minute cron to
fire twice in wall-clock time rather than backdating timestamps) plus a live browser pass. Full
detail in CLAUDE.md's "Putaway operator-assignment fairness" section; design conversation in the
`wms-putaway-design` memory.

## Session note (2026-09-02, same session — Analytics module begins: operator productivity per Pallet)
Third item in the same Putaway deep-dive: "we need to keep data ready for analytics, for each
operator whats the time for him/her at a pallet level." Started as a "this is already derivable from
existing data" answer, then explicitly upgraded by the client: **"dont call it derivable, lets start
making it available! lets make a page called analytics and start publishing these!"** — real lesson,
worth remembering generally: derivable-in-theory isn't the same as useful. Confirmed shape: full
pallet lifecycle, but always split into two separate numbers per operator (marrying time, putaway
time — never blended), plus abandoned Putaway claims flagged against whoever claimed and never
completed them, for direct follow-up ("we will then ask him/her why they didnt pick it up").

No new schema — entirely derived from `StockMovement`/`PutawayTrip` data Pallet consolidation and
Putaway already write. New standalone `analytics/` module + `AnalyticsPage.tsx` (top-level nav tab,
next to Insights but a deliberately distinct destination — not the same page). Verified via a
throwaway-company API script (21/21) plus a live browser pass. Full detail in CLAUDE.md's "Analytics
— the real module begins" section; design reasoning in the `wms-putaway-design` memory.

## Session note (2026-09-02 — Putaway deep-dive: Drive-in split from SPR/ASRS)
A direct question about existing logic, not a bug report: "divide logic of SPR & Drive in, are both
treated the same?? in the putaway logic?" Traced the real code — yes, identically, which is
physically wrong for Drive-in: an MHE can't dig past stock at one level of a Drive-in lane to reach
a different SKU buried at another level, unlike SPR/ASRS where each level is independently
addressable. Confirmed as an absolute constraint, not a policy choice — no `maxSkusClass*` tier, no
`MultiSkuLaneException` bypass, ever ("its not possible to remove 30 bins to find 1 sku if its B/C
class").

Worked through a concrete numbered example before coding (same rhythm as the 2026-08-29 "still
incoming" reservation design): a Drive-in column now fills deepest-tier-first ACROSS every level
(not "finish Level 1, then start Level 2"), bottom-up within a tier — confirmed both the overall
shape and the level tie-break explicitly. ASRS explicitly parked ("we will think about it later"),
still inheriting SPR's behavior for now. Built and verified the same session — a throwaway-company
API script (11/11, including a genuine SPR-independence control) plus a live browser pass through
the real Putaway page confirming the exact fill sequence via Rack Name labels. Full detail in
CLAUDE.md's "Putaway: Drive-in gets its own bin-suggestion strategy" section; design reasoning in
the `wms-putaway-design` memory.

## Session note (2026-09-01 — Pallet consolidation built and verified, from the 2026-08-31 design)
Picked up the closed design below directly, per its own instruction ("nothing was built, this is a
closed design for a future session to implement directly") — no re-discussion needed, one real
mechanical gap surfaced and got resolved first: the design didn't specify HOW "marrying" touches the
stock ledger. Two concrete options were laid out with worked examples — fold it into the existing
Inbound scan (no new screen) vs. a genuinely separate "Load Pallet" step needing its own zero-net
ledger write. **The client's call: fold it into the scan** — "we are just adding one more scanning
layer from which we would loose time." Everything else matches the closed design exactly: `Pallet`/
`PalletLoad` (mirroring Vehicle/VehicleGateEntry), single-SKU-per-pallet, auto-close on
`Sku.maxCasesPerPallet ?? Company.defaultMaxCasesPerPallet` or manual short-close, warehouse-scoped
bulk generation with Code128 labels (same mechanism as Location Labels), Putaway's task trigger
shifting to "pallet closed" for this path only, and reuse (not a fresh id) once a load's stock fully
depletes — though that depletion itself needs the still-unbuilt Picking module to ever actually fire.

Verified two ways: a throwaway-company API script (42/42 — auto-close at the effective cap across
multiple pallets each producing their own `PutawayTask`, the single-SKU lock blocking a genuinely
different expected SKU, manual short-close sizing a task to exactly what was scanned, and a
regression check confirming ordinary non-palletized receipts are completely untouched), a second
script closing the loop all the way through a real Putaway bin suggestion, multi-trip claim/complete,
and the receipt reaching `PUTAWAY_COMPLETE` (15/15), then a live browser pass through the real Pallet
Master page, SKU Master's new field, Company Settings' new field (survived a real reload), and a
real Match Order → Receiving → scan → Short Close cycle through the actual rendered UI. Full detail
in CLAUDE.md's "Pallet consolidation" section.

**Genuinely still open**: Picking doesn't exist yet, so a `Pallet` never actually gets exercised
back to `AVAILABLE` in practice today — the field/logic is ready, just unexercised. Mixed-SKU
pallets and a real geometric best-fit calculator remain explicitly out of scope, unchanged from the
original design.

## Session note (2026-08-31, design-only — Pallet consolidation ("marrying" cases to a pallet))
A real physical-operations gap raised directly: when loose cases (not pre-built pallets) come off a
truck, staff stack several onto a pallet before it goes into a rack. Today's system has zero concept
of a physical unit/pallet identity — it's a pure quantity ledger (`StockMovement` only ever tracks
SKU + Location + quantity). This session designed the concept end-to-end through several rounds of
"let's discuss" — **nothing was built, this is a closed design for a future session to implement
directly.**

**The shape, settled point by point**:
- Two new entities, mirroring the existing `Vehicle`/`VehicleGateEntry` pattern:
  - **`Pallet`** — the physical asset. Warehouse-scoped (doesn't roam between warehouses, same
    reasoning as the 2026-08-28 Vehicle/Driver reversal). Registered via a bulk range generator
    (same shape as Locations' generator), with a print-labels option — a real barcode goes on the
    physical pallet **once**, at registration, never reprinted per load. Sits `AVAILABLE`/`IN_USE`.
  - **`PalletLoad`** — one row per load cycle (SKU, quantity, built/emptied timestamps).
    `StockMovement` references the load, so "how much is on this pallet" is always derived from the
    ledger, never a stored counter — same philosophy as everywhere else in this codebase.
- **Where it happens**: after unloading, before Putaway — loose cases get scanned in exactly as
  today, then married onto a `Pallet` as a new consolidation step. Conditional, not universal: a
  receipt that arrives as ready-built pallets skips this entirely; it only applies when material
  arrives as loose cases that need consolidating. "Depends on the industry" — the client's own
  framing.
- **Single SKU per pallet only** — no mixed-SKU pallets in this design.
- **Ad hoc quantity, capped**: closed either by hitting a max-cases number, or by an operator's
  manual short-close (that SKU's remaining quantity ran out first). The max itself follows the
  exact override pattern this codebase already uses everywhere (`Company.putawayDefaultBatchQty` +
  `Sku.putawayBatchQty`, `VehicleType.maxTonnage` + `Vehicle.maxTonnage`): a general company/category
  default for standard case+pallet dimensions, plus a new **`Sku.maxCasesPerPallet`** override field
  on the SKU Master page for anything non-standard (tyres — "not standard at all... we will need
  different bestfit for each SKU"). That per-SKU number is manually typed in from real staff
  experience, **not calculated** — an actual geometric best-fit/packing algorithm was explicitly
  ruled out as a separate, much bigger future problem, same tier as the still-deferred GS1 barcode
  parsing ("Reading B").
- **Putaway's trigger shifts, for this path only**: instead of firing per scan/batch as today, a
  task fires when the pallet is closed — one task, one pallet, moved as a single unit. Non-
  palletized receipts keep today's behavior completely unchanged.
- **Reuse, not a fresh ID per cycle**: once a `PalletLoad`'s contents are fully picked/dispatched
  (derived quantity hits zero), the same physical `Pallet` — same id, same barcode sticker — frees
  up for its next load. The client's own call: "after that pallet's dispatch is complete, we will
  use it again, why not" — a real reusable physical asset, not a disposable per-trip LPN.
- **Matters end-to-end, confirmed explicitly** — not just for Putaway. The client's own reasoning:
  "if we need to pick 5 cases, we should know how many pallets to pick" — this is meant to inform
  the still-unbuilt Picking module's design once that stage comes up, not just close out Putaway.

**Explicitly out of scope, don't build without re-confirming**: mixed-SKU pallets, and any real
geometric best-fit calculator for irregular items — both were raised and deliberately excluded.

See `[[wms-putaway-design]]` in memory for the naming note (`SkuStorageUnit.unitType` already has an
unrelated existing value literally called `"PALLET"` — a generic per-SKU quantity multiplier, not
this new physical-asset concept; both will coexist in the schema, flagged so it isn't a surprise).

## Session note (2026-08-29, same hardening-phase session — new Insights page, Storage Utilization by ABC Class)
A genuinely new feature, not a hardening fix — but a small, deliberately scoped one, worked out via
several rounds of "let's discuss" before any code (per the standing rule). The client's own framing:
"we need to understand utilization of A/B/C storage, this will make us change our storage strategy...
it will allow us to tell clients valuable insights" — directly connects to the same-session's earlier
fixes (A/B's exclusivity and C's "still incoming" reservation are exactly what determines how much
space goes unused). First report: for each ABC class, of the rack-storage lanes currently holding
that class's stock, how many of those lanes' total bins are actually occupied.

**Confirmed shape**: real on-hand stock only (not pending reservations) decides which lanes count;
a completely empty lane is excluded entirely, not shown as 0%; rack storage only (SPR/Drive-in/
ASRS, the same universe `suggestBin()` itself uses); per warehouse, no company-wide rollup yet; an
unclassified SKU counts as Class C (matching existing convention); a rare mixed-class lane (only
possible via an active `MultiSkuLaneException`) counts under every class present — a known v1
simplification, not fixed properly. New standalone top-level "Insights" nav tab, positioned next to
Gate & Yard per the client's explicit call, gated to Company Admin/Warehouse Manager/Warehouse
Supervisor. A Warehouse picker plus three colour-coded stat-cards (A/B/C) — no table/drill-down in
v1.

Verified two ways: a short-lived diagnostic script built a real 3-lane scenario directly against the
live dev DB (an A-class lane 1-of-3 full → confirmed 33.3%; a C-class lane shared by two different
SKUs, 3-of-3 full → confirmed 100%; a genuinely empty lane → confirmed absent from every total, not
a 0% row), then the exact same real data was checked live through the actual rendered UI (logged in
via the API+localStorage token trick), confirming all three numbers matched exactly. `tsc -b`/`tsc
--noEmit` both clean. Full detail in `CLAUDE.md`'s "Insights module — Storage Utilization by ABC
Class" section.

## Session note (2026-08-29, same hardening-phase session — "still incoming" lane reservation for Class B & C)
Follow-up to the aging-granularity fix below, same session. The client raised a scenario directly:
"if a vehicle contains more than one level full of a C-class SKU, those depths should be assigned for
them only" — worked through via a concrete worked example first (per the client's own "let's make an
example and discuss" ask) before any code, which surfaced the real mechanism needed:

- **The gap**: `suggestBin()`'s "prefer the fullest lane" rule has never distinguished "this lane's
  occupant still has more of itself coming off the vehicle" from "this lane's occupant is done and
  just sitting there." A large SKU (needing e.g. 3 depths) can get fragmented across two lanes if a
  smaller, unrelated SKU happens to arrive in between and gets funneled into the same lane.
- **The fix**: before letting a different SKU share a lane, check whether any current occupant SKU
  still has `receivedQty < expectedQty` on any `InboundReceiptLine` — if so, the lane is off-limits to
  any other SKU, overriding `maxSkusClass*` entirely. Reopens the instant that occupant's line
  completes. No new schema — reuses data Inbound receiving already writes. The client's own framing,
  "keep it at a vehicle level check itself, that's enough," is exactly what made this simple — no
  order-profile modeling needed, `InboundReceiptLine` already has the answer.
- **Scope, confirmed by tracing each class**: Class A needs nothing (its cap of 1 already locks a
  lane permanently, this rule is redundant there); Class B and C both get it — the client's explicit
  call, "B also keep 2 as same" (the cap number itself unchanged) "but... can we keep that as a
  toggle" (see the dead-field finding below).

**Follow-up decision, same session, minutes later**: the client resolved the self-exclusion bug
question — rather than fixing the underlying "exclude myself from the occupant count" logic now,
`WarehouseStorageType.maxSkusClassB`'s default was dropped from 2 to 1 (matching Class A's full
exclusivity) as a deliberate interim workaround: with cap=1, a B-class lane can never hold two
distinct SKUs in the first place, so the bug's trigger condition (a lane whose cap allows >1 SKU)
never arises. Migration `20260829110000_max_skus_class_b_default_one` — only affects a **newly
created** `WarehouseStorageType` row, same "no backfill, no real client tenant yet" pattern as this
project's other default-only changes. Verified via a throwaway warehouse: a fresh SPR storage-type
row now reads `maxSkusClassA: 1, maxSkusClassB: 1, maxSkusClassC: null`. **Two items explicitly
deferred, not built** — see the Deferred section below:
1. The general self-exclusion cap-logic fix itself (needed once B, or any future class, gets a cap
   above 1 again).
2. **`WarehouseStorageType.maxSkusClassA/B/C` is still a completely dead field** — same shape
   `agingGranularity` was in before this session's first fix, but bigger: `WarehouseStorageType` rows
   have no edit path at all today (only ever created, never updated), so exposing this needs a real
   scope decision (create-time-only, or build a first-ever edit capability).

Verified live against the real dev DB via a short-lived diagnostic script (created, run, deleted) —
a B-class scenario matching the worked example exactly, all 3 steps passing (a different SKU blocked
while the occupant is still incoming; the occupant's own top-up unaffected; the different SKU
correctly allowed in once the occupant's line completes). Full detail in `CLAUDE.md`'s "Putaway:
'still incoming' lane reservation for Class B & C" section.

## Session note (2026-08-29, next session — hardening phase begins: aging-granularity default + per-warehouse Settings UI)
First session run under the new "no new modules, fix what's already built" direction (see
`[[wms-hardening-phase]]`). Investigated a specific scenario raised directly: SKU unloaded in the
morning fills 2 of a 3-deep lane's depths — does the system suggest the 3rd depth for the same SKU
received that evening? Traced through the real `suggestBin()` code (not guessed): no — the same-SKU
top-up rule's aging check defaulted to requiring an exact-millisecond `receivedDate` match (since
`Company.agingGranularity` had existed since 2026-08-28 but was never wired to any UI/API anywhere,
every company was silently stuck on this). Fixed in two steps, both confirmed with the client before
building:
1. **Default to same-calendar-day**, not exact-millisecond — "same calendar day would do... too much
   check" for exact-match. One-line fix; the `DAY` bucket logic already existed and was already
   correct, just never used as the fallback. Verified live against the real dev DB via a short-lived
   diagnostic script.
2. **Moved `agingGranularity` from `Company` to `Warehouse`**, once the client pointed out it isn't
   really a company-wide fact — "depends on the node the granularity might be different," same
   reasoning behind `WarehouseEquipmentSuitability` being warehouse-scoped. New migration, and a
   real Settings UI finally exists for this field for the first time: a per-warehouse "Aging
   Methodology" (Day/Week/Month) control on Company Settings' Putaway section — a warehouse picker +
   dropdown + Save, since there's no general Warehouse Edit form to hang this off instead. Verified
   end-to-end through the actual rendered UI (two real throwaway warehouses, saved one to Month,
   reloaded the page, confirmed via the live DOM the correct value came back).

Full technical detail in `CLAUDE.md`'s "Putaway: aging-granularity default fixed, then moved to
Warehouse with a real Settings UI" section.

## Session note (2026-08-29, Putaway live-testing: three real bin-suggestion bugs, plus four smaller items)
A live-testing session (not a design conversation) working from real screenshots of the actual
Putaway queue, not a script. Three distinct, real bugs in `suggestBin()` — each one caught by the
client's own trace through concrete before/after location codes, not guessed at:

1. **Pending-reservation blind spot** — two units of the same SKU, scanned close together (before
   the first trip physically completed), landed in different levels instead of filling one lane's
   remaining depths, because the "prefer an already-open same-SKU lane" rule only recognized real
   completed `StockMovement` rows as "in use," not another still-`PENDING` task's own reservation.
   Fixed: a bin already the destination of another open task now counts as reserved.
2. **Lane-fullness preference, fixed twice** — first pass added a "prefer any lane with a compatible
   occupant, even a different SKU" tier, which fixed 3 different C-class SKUs each opening their own
   level instead of sharing one lane. But the client's own trace caught a second, subtler gap: exact-
   SKU-match still unconditionally outranked a *fuller* lane held by a different SKU, so a SKU
   returning to its own mostly-empty leftover lane could win over joining a lane already 2/3 full.
   Fixed properly the second time: both tiers replaced with one number — how many positions in the
   lane are already occupied, by anyone — always preferring the fullest eligible lane. Verified live:
   3 C-class SKUs correctly landed D3/D2/D1 in one shared lane.
3. **Flank-merging bug (`laneKeyOf`)** — on a mirrored aisle ("Mirror same numbers on other side" in
   the generator), `R01` and `R01B` are physically separate racks, but the lane-grouping key only
   used `(aisle, rack, level)` — since both flanks store the literal rack value `"01"` (the "B" only
   ever exists in the *display* code), two separate racks were silently merged into one fake 6-deep
   lane. This is very likely the root explanation for cross-flank ping-ponging seen earlier in the
   same session too. Fixed: `flankNumber` is now part of the grouping key.

**Also same session**: Putaway's task queue now shows a human "Rack Name" (`R2-01-L05-D3`) instead
of the raw DB code (`1-R01B-...`) everywhere — matching the Plan View, which already used this
label — after the client caught the two views showing different labels for the same bin;
`completeTrip()`'s location-scan step now accepts this same string, since there's still no real
printable label to scan against. **Gate In now hard-blocks a vehicle that already has an open entry
elsewhere** — a real gap with zero design/schema before this, company-wide scope (matches the
existing Inbound-order-per-vehicle precedent), no toggle since it's a physical fact, not a policy
choice; proven against real pre-existing test data that had already silently hit this exact bug
twice. **No cancel/void path for a mistaken Gate In exists yet** — flagged, not built, a real gap if
this block ever traps a genuine data-entry mistake. **Putaway's task queue gained a Truck No. / PO
Number filter** (plus both as real columns), for finding one vehicle's or order's tasks without
scrolling. **Inbound Orders gained a genuine Delete All** — deliberately *not* the "block if it has
real transaction history" shape every other Delete All in this app uses; this one actually deletes
the `StockMovement` rows an order generated (a first for this otherwise fully append-only ledger),
confirmed directly with the client first ("only ledger data, not the code").

A real process note, worth being honest about: this session had several rounds of coding ahead of
explicit go-ahead, each one caught and corrected by the client directly — not a one-off, a repeated
pattern across the same session despite the standing rule being well-established (see
`[[wms-align-before-coding]]`, updated with this instance).

**Same session, a real follow-up once testing surfaced the next gap**: closing the Putaway loop end-
to-end raised a genuine question — how do you actually scan a location's destination in production,
not just by typing the on-screen Rack Name for testing? A short discussion settled it: no new
schema/table needed (unlike `SkuBarcode`, a location has no externally-sourced multiple-barcode
problem — we're the only party assigning its identity), just a real printable barcode encoding the
location's own existing Rack Name. Built as **Location Labels** — `POST /locations/labels` generates
a downloadable ZIP of individual Code128 PNG barcodes (via `bwip-js`/`archiver`), one per requested
location, available both right after the range generator (labels for the just-created batch) and as
a standalone "Download Labels" action on the Table View's already-filtered list. Verified directly
against real location data — a real ZIP, correctly named files, one barcode visually confirmed as a
readable Code128 image. See `CLAUDE.md`'s "Location Labels" section for full detail.

## Session note (2026-08-28, Vehicle/Driver warehouse-scoped visibility — a real reversal)
Live-testing (not a design conversation) surfaced this: different warehouses under one company can
be run by different 3PLs, so Vehicle/Driver being visible company-wide (the original 2026-08-26
design, chosen because "a truck roams between warehouses") was a real privacy leak — "if its
registered in TN08, TN08 only should see it... can be data privacy." Reversed: `Vehicle.warehouseId`/
`Driver.warehouseId` (required going forward), `findAll()`/`assertAccess()` scoped the same way
Warehouse/Customer/User already are for Manager/Supervisor, registration modals and pickers on Gate
& Yard/Inbound Orders re-scoped to match, and Vehicle & Driver Master gained a Warehouse column,
filter, and edit-form field (the fix path for a pre-existing null-warehouse row). Confirmed
trade-off, accepted explicitly: a vehicle now needs re-registering at every warehouse it genuinely
visits — no more free cross-warehouse reuse. `WarehousesService`'s Delete All blocking check also
proactively gained `vehicles`/`drivers` (same "go back and add it" lesson this project already
learned once with `gateEntries`, applied before hitting the bug this time, not after).

Same session, a separate real fix from live-testing: an unregistered barcode (zero `SkuBarcode`
rows anywhere) used to allow a free, unrestricted Supervisor override onto any SKU during Inbound
receiving — reversed to a hard block ("an unregistered barcode is a MORE serious problem than one
registered to the wrong SKU, not a lesser one"). A blocked scan with an unrecognized barcode can now
only be Rejected, never Approved — register the barcode against the right SKU first if it's a
genuinely valid product. See `CLAUDE.md`'s matching sections for both — full verification detail in
each.

## Session note (2026-08-28, Location-category-aware bin suggestion + Inbound category visibility)
A real, previously-unused signal got wired in, from a client-initiated discussion (not a bug
report): `Location.categoryId` — a real, optional per-rack tag staff can set at generation time,
already shown on the Plan View and cross-checked by the Storage Type Mapping table — had never
actually been consulted by `suggestBin()`. Putaway only ever checked the coarser
`WarehouseStorageType`-level plan ("is Category X planned for SPR at all, with how much capacity"),
then considered *every* rack of that storage type in the warehouse, ignoring which specific racks
were individually tagged.

**Now (`putaway-tasks.service.ts`'s `suggestBin()`)**: after the existing warehouse-level plan
check narrows to eligible storage types, the location query is further narrowed to racks whose own
`categoryId` matches the SKU's Category — but only when at least one eligible rack is actually
tagged that way. The moment none are (tagging is optional, a warehouse may never bother), it falls
back to considering every eligible-storage-type rack exactly as before — confirmed explicitly by
the client: "if there is no category details given by them, then we need to fall back to [the old
behavior] or else the putaway will never work." No new lane-level logic was needed — the filter
sits on the same query that runs before lanes get grouped, so lane-level consistency falls out for
free (a whole rack range is normally tagged with one Category in one generator call anyway).

**Also, same root cause**: SKU Category was completely missing from the Inbound list — added as a
new "Category" column on the Receiving modal's expected-lines table (`InboundOrdersPage.tsx`),
backed by adding `category` to the SKU `select` on both `InboundReceiptsService`'s and
`GateEntriesService`'s receipt-line/scan includes.

Verified via a two-warehouse throwaway-company API script: one SKU (Category "2W tyres"), one
warehouse with 2 racks tagged that Category and 2 tagged a different one (Carbonated) — a receipt
line for that SKU correctly landed the created PutawayTask on the correctly-tagged rack, never the
mismatched one, despite both being SPR-eligible. A second warehouse with the SPR/Category plan in
place but **zero** racks actually tagged that Category (only Carbonated-tagged ones) correctly fell
back to suggesting one of those instead of returning `NEEDS_BIN` — confirming Putaway never
dead-ends on an untagged warehouse. Then re-verified live in the actual browser: opened the real
Receiving modal and confirmed the new Category column renders "2W tyres" for the test SKU, reading
live off the real saved data, not a hardcoded value.

## Session note (2026-08-28, closing the Putaway trigger-mode settings gap)
Caught right after the Putaway build above shipped: `Company.putawayTriggerMode`/
`putawayDefaultBatchQty` were real, working schema fields with real logic behind both modes, but
had never been wired into `CompaniesService`/`CompaniesController`/`CompanySettingsPage.tsx` — every
company was silently stuck on whatever the schema default happened to be, with zero UI/API to
change it. Two things resolved:
1. **A new "Putaway" section on Company Settings** (same shape as Detention/ERP Integration) — a
   Trigger Mode dropdown (Immediate/Batch) + an optional Immediate-mode batch-size input, wired
   through `CompaniesService.getSettings()`/`updateSettings()` exactly like every other setting on
   that page.
2. **The schema default itself flipped from BATCH to IMMEDIATE** — BATCH had only ever been my own
   unconfirmed assumption from the original Putaway build session, flagged explicitly rather than
   silently kept. Asked directly; the client's answer — "if there are 10 cases of same SKUs, even 1
   case is scanned, we should be able to putaway" — is exactly IMMEDIATE mode with no company-wide
   batch threshold (`putawayDefaultBatchQty` stays null by default, meaning every accepted/approved
   scan becomes its own task immediately). Migration
   `20260828200000_putaway_trigger_mode_default_immediate` only changes the DB default for a
   newly-created company — it does not retroactively touch any already-existing company's stored
   value (same "no real client tenant identified in the dev DB yet" situation as the Dock Door
   auto-generation pass — nothing to backfill against).

Verified via a throwaway-company API script (6/6: a fresh company defaults to IMMEDIATE/null,
PATCH to BATCH+50 persists and reads back correctly, clearing back to IMMEDIATE/null works, an
invalid trigger mode and a negative batch qty both correctly 400) plus a live browser pass —
changed Trigger Mode to Batch and set a batch size of 25 through the real Company Settings form,
reloaded the page, and confirmed via the live DOM (not just displayed text) that both values
persisted through a real save → reload round-trip.

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
| **Putaway** | ✅ Core logic built + live-verified (2026-08-28), three real bin-suggestion bugs found and fixed via live testing (2026-08-29) — BATCH/IMMEDIATE trigger modes, ABC/multi-deep-lane-aware bin suggestion (now reservation-aware, fullest-lane-preferring, and flank-correct), scan-driven staging→bin execution (claim/complete, no override, now accepts the human "Rack Name"), Multi-SKU Lane Exception workflow, receipt-level PUTAWAY_COMPLETE signal, a Truck No./PO Number filter, (2026-09-01) Pallet consolidation — "marrying" loose cases onto a pallet before Putaway, folded into the existing Inbound scan, shifting the task-creation trigger to "pallet closed" for that path — (2026-09-02) Drive-in split from SPR/ASRS into its own bin-suggestion strategy (whole-column absolute single-SKU, deepest-tier-first/bottom-up fill) — and (2026-09-02) operator-assignment fairness (live "who goes next" recommendation ranked by idle time among MHE-capable operators, oldest-staged-stock priority signal, Supervisor→Manager escalation if ignored — a live recommendation, not a hard task lock). — and (2026-09-05) **Pick Face for SPR**: a `Warehouse.pickFaceEnabled` toggle gates a daily reslotting job keeping each SPR pick face location (whole bottom level of a lane) stocked with the warehouse's current highest-priority A/B-class SKUs, refilling an empty slot from reserve or proactively evicting a lower-class occupant for a higher one (strict class-tier order, C never eligible, no fixed SKU-to-location binding — purely derived from live on-hand); new `PickFaceTask`/`PickFaceTrip` models (not a `PutawayTask` variant) with the same scan-driven claim/complete UX, dormant against real depletion until a future Picking module writes `MovementType.PICK` (schema-only today). Still open: Ground/Stillage's own version of the multi-position logic, a cancel path, correcting an already-completed mis-putaway, ASRS's own bin-suggestion strategy, Ground/Block operator routing, unloading-team assignment fairness, Pallet reuse (needs Picking to ever actually deplete a load), and Pick Face for Drive-in/ASRS/Ground/Stillage (deliberately deferred, SPR only for now) — see `wms-putaway-design` memory |
| Inventory | ⬜ Not started — no live on-hand stock view exists anywhere yet |
| Outbound | ⬜ Not started — schema exists, no logic/UI |
| Picking | ⬜ Not started |
| Dispatch | ⬜ Not started |
| Returns | ⬜ Not started |
| **Analytics** | 🟨 Started (2026-09-02) — the real module, distinct from the earlier one-off **Insights** page (which still only has Storage Utilization by ABC Class). First report: operator productivity at the Pallet level — marrying time and putaway time per operator (always split, never blended), plus abandoned Putaway claims flagged against the operator who claimed and never completed them. No new schema, entirely derived from existing Pallet/Putaway data. (2026-09-05) Gained a fourth, separately-reported metric — Pick Face trip time per operator, grouped by task rather than pallet. |

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

## Session note (2026-08-28, Putaway kickoff conversation — MHE master built, task logic still not started)
Picked the three workflow questions back up: task creation trigger, bin selection, and page location
all got real answers (per-line/per-batch trigger modes with a company toggle, system-suggested bin
only — "it can never be operator's decision", a standalone Putaway page) — but jumping straight into
`PutawayTask` schema off those answers alone was premature and got called out directly. Real
process note: mid-conversation code got written and was reverted (`git checkout` on
`schema.prisma`, nothing else touched) before the conversation actually continued. See
`[[wms-align-before-coding]]`.

Five more real dimensions surfaced once discussion continued: multi-dock parallel picking, operator-
to-vehicle assignment (dedicated vs. pooled), physical execution method (manual vs. MHE), and bin
consolidation. Resolutions: consolidation is out (bin suggestion only ever offers a genuinely
available bin); multi-dock-parallel and dedicated-vs-pooled operator assignment are both
deliberately **not** enforced modes — "we need to build both... our value add should be that we
need to suggest which way is better after a few days of operations" — i.e. let staff work however
they naturally do, capture the data, let a future Analytics pass compare patterns. MHE turned out
to be the real blocker: **"we need to get the MHE master at start, and work accordingly, the
throughput of each mhe would be different."**

This session built that master: `EquipmentType` (platform-seeded — Manual, Hand Held Trolley, HOPT,
BOPT, Stacker, two Forklift sub-types, Reach Truck, DDRT, each with a placeholder generic
pallets-per-trip/avg-trip-minutes) + `Equipment` (a company's own warehouse-scoped registered
units, overriding the generic numbers) — full CRUD, a new "Equipment (MHE)" page under Masters,
verified via a throwaway-company API script and a live browser pass. Full detail in `CLAUDE.md`'s
"MHE (Material Handling Equipment) master — built before Putaway itself" section.

**Same-session follow-up, corrected same day**: a six-activity suitability matrix
(Putaway/Picking/Loading/Unloading/Consolidation/Inventory Check, each PRIMARY/SECONDARY/NOT_USED)
was added — your own ask, "so we get all the mhe's in warehouse instantly." First built directly on
`EquipmentType` (shared platform-wide, no edit path) — caught immediately ("where is the matrix for
input??") and corrected to be **warehouse-wise**, per your own call: "it should be warehouse wise!
you can give dropdown for wh code and give matrix." Now a real `WarehouseEquipmentSuitability`
table, one row per (Warehouse, EquipmentType), auto-populated with sensible defaults at warehouse
creation and fully editable via a real "Equipment Type Matrix" screen (pick a warehouse, edit a 9×6
grid, save). `GET /equipment?activity=X&warehouseId=Y` gives the real, Primary-ranked instant
lookup the original ask wanted. Full detail in `CLAUDE.md`'s "MHE activity suitability matrix"
section (includes the correction story). **Putaway's own task logic (trigger modes, bin suggestion,
batching, claiming) is still NOT started** — a real workflow conversation designing that logic
against this real, warehouse-specific equipment data is the natural next step, not a re-litigation
of what's already been decided above.

## Session note (2026-08-28, same day — Putaway's actual logic built and verified)
Picked the design conversation back up, deliberately slower this time — "lets deep dive, ask as much
questions you need... so we will think about topics i have not thought about yet." Real ground
covered before any more schema: the client's own scan-based execution vision (scan the case/pallet
at staging → system says where → scan the destination to confirm, no override), a full brainstorm of
gaps the earlier design missed (double-booking, task claiming, the dead `PUTAWAY_COMPLETE` status),
and — the biggest piece — a real racked-vs-non-racked split that led to the mandatory single-SKU-
per-multi-deep-lane rule (reusing `maxSkusClass*`, unenforced since 2026-08-24), the Multi-SKU Lane
Exception request/approve/revoke workflow ("so both the local and HO team knows there is a
problem"), and "localized aging" (`StockMovement.receivedDate`, sourced from Dock In, a deliberately
simple stand-in after real manufacturing-date tracking was raised then parked — it ties into the
already-deferred Batch/Lot topic). Also added, mid-conversation: `EquipmentType`/`Equipment` gained
nullable loaded/unloaded speed (km/h) fields, schema-only — real numbers are coming from the client
separately.

All of it got built the same session — schema, then real service logic, then a live UI — not left as
another skeleton. Full detail in `CLAUDE.md`'s "Putaway — design conversation, schema, and working
logic" section; the complete design history (including the mid-session schema-before-alignment
misstep that got caught and reverted) lives in the `wms-putaway-design` memory. Verified 20/20 via a
throwaway-company API script plus a live browser pass through the real "Putaway" page (claim, a real
wrong-location hard-block, a correct completion, and the receipt's `PUTAWAY_COMPLETE` flip confirmed
directly against the database).

**Genuinely still open, not decided**: Ground/Stillage's own version of this logic (deliberately
deferred — racked came first), a cancel/exception path for a task that can't be completed at all, how
an already-completed mis-putaway gets corrected, and real queue-ordering/aging-based task
prioritization (the FIFO discussion got paused for the racked-vs-non-racked detour and was never
fully resumed).

Pick any of these, not a forced order — refreshed 2026-09-06 (the previous version of this list was
stale, still describing Putaway as unbuilt from a much earlier session; see CLAUDE.md's build log
for everything that's actually shipped since).

## Immediate candidates for the next session

Pick one — these are the live options on the table, not a forced order:

1. **The reslotting/consolidation suggestion engine** (2026-09-06) — now genuinely unblocked: both
   Topic 1 (real per-warehouse ABC classification) and Topic 2 (dock-relative placement rules) it
   was waiting on are built. `ReslottingSuggestion`/`ReslottingSuggestionSource` schema has sat ready
   since Topic 1 — the actual detect-a-misplaced-SKU/suggest-a-target-bin algorithm and its daily job
   still need designing and building.
2. **FMS classification combined with ABC, for exact material putaway** (2026-09-06, new) — "go in
   depth for FMS model of inventory as well, looking at the combo of abc and fms we need to make a
   logic of exact material putaway." FMS (Fast/Medium/Slow-moving, ranked by movement *frequency*)
   is a different axis than ABC (ranked by dispatched quantity/value) — a combined ABC×FMS matrix is
   the natural next refinement on top of Topics 1/2's placement work, and closely related to item 1
   above. Nothing designed yet — see the new section in the `wms-abc-velocity-design` memory for the
   real open questions to raise first (what drives FMS, how many tiers, how the combined matrix
   actually changes `suggestBin()` beyond what ABC + dock-proximity already do).
3. **Inventory (basic on-hand view)** — there is currently *no screen anywhere* to see "what's on
   hand at Location X." The ledger (`StockMovement`) has real data in it now, but nothing renders
   it. Even a read-only view would close a real, felt gap. Next in the stated module build order.
4. **Outbound order maker** — destination + vehicle capacity check (weight *and* volume), triggering
   a pick list — the module after Inventory in the build order. Benefits from Inventory existing
   first so a "can this order be fulfilled" check means something.
5. **Dock-out → Gate-out signal** — an active notification telling security a vehicle is ready to
   Gate Out, plus real logic for the fact that paperwork/documentation still takes time after
   dock-out before Gate Out can actually happen. Needs a real design conversation first (touches
   similar territory to the still-fully-deferred Dock Scheduler) — not a quick toggle.
6. **Dock + Staging + Yard visualizer** — paused mid-conversation before any decisions were made.
   Same spirit as the Locations Plan View. Needs a real spatial-data pass first (Dock Doors/Yard
   Slots have no position/sequence data today) — see the four open questions in the session note
   above before building anything.
7. **A cancel/void path for a mistaken Gate In** (2026-08-29) — Gate In hard-blocks a vehicle that
   already has an open entry elsewhere, but there's still no way to void a genuinely mistaken entry
   (wrong vehicle typed, never gated out) — today that needs a manual Gate Out to clear. Flagged,
   not designed.

Also genuinely still open within Putaway itself, not a separate module: Ground/Stillage's own
version of the multi-position bin logic (racked came first, on purpose), a cancel/exception path for
a task that can't be completed, correcting an already-completed mis-putaway, and real queue-
ordering/aging-based task prioritization.

## Deferred, lower priority (per your own explicit calls — don't build unprompted)

- **Putaway's self-exclusion cap bug** (`suggestBin()`, 2026-08-29) — a SKU already occupying a
  multi-SKU lane can get wrongly blocked from its own lane's last empty depth once the lane hits its
  distinct-SKU cap, since the eligibility check doesn't exclude "myself" from the occupant count.
  Currently side-stepped, not fixed — `maxSkusClassB`'s default was dropped to 1 (see this date's
  session note) so the bug's trigger condition (a cap > 1) never arises today. Revisit the real fix
  once a class needs a cap above 1 again.
- **`WarehouseStorageType.maxSkusClassA/B/C` is a completely dead field** (2026-08-29) — no UI/API
  anywhere lets a client set it; every warehouse is stuck at the DB defaults forever. You want it
  client-configurable ("let it be a client decision, not ours") but `WarehouseStorageType` rows have
  no edit path at all today (only ever created, never updated) — needs a real scope decision
  (create-time-only fix vs. a first-ever edit capability for these rows) before building.
- **Stillage still has no Putaway bin-suggestion logic of its own** — untouched by the Ground/Floor
  work below; `suggestBin()` still has no real placement logic for `STILLAGE`, always returns
  `NEEDS_BIN`. Not yet even design-discussed.
  isn't a small extension of the existing algorithm, it's closer to a second, genuinely different
  placement strategy — same shape as the Drive-in split, likely bigger.
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

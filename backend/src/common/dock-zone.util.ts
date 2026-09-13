// Outbound-proximity ranking for Putaway's bin suggestion (Topic 2 of the
// ABC-velocity/dock-relative-placement design — see CLAUDE.md's "ABC
// velocity reassessment" section and the wms-abc-velocity-design memory).
// Confirmed: fast movers (A/B) should land near whichever dock zone serves
// OUTBOUND (even though Outbound/Picking doesn't exist as a module yet —
// "it should go to near the outbound end"), slow movers (C/D) far from it.
//
// A warehouse's real dock geometry is captured coarsely, at the warehouse
// level, via WarehouseDockZone (1-2 zones: which end of the warehouse's own
// natural-sorted aisle order a dock zone sits near, and what it serves) —
// deliberately NOT a per-aisle numeric measurement, which the client
// rejected outright ("no no, not the right way") in favor of researching
// real warehouse archetypes (U/I/L-shape) and deriving proximity from the
// aisle order that's already stored, for free.
//
// naturalCompare/uniqSorted here are the backend port of the exact same
// helpers already established on the frontend (locationBoxUtils.ts) for
// sorting aisle codes like "2" < "10" — kept as a separate copy since this
// codebase's backend/frontend don't share code at all (no monorepo
// tooling), same as every other cross-side duplication already documented
// (authHeaders, SignaturePad, etc.).
function naturalCompare(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (a.trim() !== '' && b.trim() !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a.localeCompare(b);
}

// numberOneNearDock (2026-09-12, same-day follow-up to the compass-direction
// rename — see schema.prisma's own comment on WarehouseDockZone for the full
// story) replaces what used to be a hardcoded assumption baked into the
// EAST/SOUTH-vs-WEST/NORTH branches below: which end of the Aisle/Row
// NUMBERING actually sits nearest the dock. A real client catch, live-
// testing Bin Rank against TNR8's own data: "we need to have idea of from
// where the row 1 starts... we need to get info during warehouse stage so
// this issue doesnt pop up" — dockSide alone only ever said which WALL the
// dock touches, never which numbering end is closest to it, and the old code
// just guessed (Aisle 1/Row 1 always nearest for EAST/SOUTH, the opposite
// for WEST/NORTH) with nothing to confirm that against how a real warehouse
// was actually numbered when it was generated.
export type DockZoneRow = { purpose: string; dockSide: string; numberOneNearDock: boolean };

// Builds a function mapping an aisle code -> its outbound-proximity rank
// (lower = closer to whichever end an OUTBOUND/BOTH zone is declared near).
// Returns null when the warehouse has no OUTBOUND-serving zone configured
// at all — callers fall back to today's flankNumber-based proxy in that
// case, so an unconfigured warehouse behaves exactly as it always has.
export function buildOutboundProximityRanker(distinctAisles: string[], dockZones: DockZoneRow[]): ((aisle: string) => number) | null {
  // 2026-09-12: DockCompassDirection has 4 values (renamed from LOW/HIGH/
  // ROW_LOW/ROW_HIGH — see schema.prisma's own comment), but THIS function
  // only ever ranks the AISLE axis (EAST/WEST) — a NORTH/SOUTH zone (near
  // the front/back of every aisle, not near either end of the aisle
  // sequence) has nothing for this particular ranker to do with it, and
  // must NOT silently fall into the "else = WEST" branch below (that would
  // misrank every aisle). Filtered out here rather than left to the caller
  // — a warehouse whose only configured zone is North/South correctly
  // falls back to null/"not configured" for aisle-proximity purposes, same
  // as having no zone at all.
  const outboundZones = dockZones.filter((z) => (z.purpose === 'OUTBOUND' || z.purpose === 'BOTH') && (z.dockSide === 'EAST' || z.dockSide === 'WEST'));
  if (outboundZones.length === 0) return null;
  const sorted = Array.from(new Set(distinctAisles)).sort(naturalCompare);
  const n = sorted.length;
  const indexOf = new Map(sorted.map((a, i) => [a, i]));
  return (aisle: string): number => {
    const idx = indexOf.get(aisle);
    if (idx === undefined) return Number.MAX_SAFE_INTEGER;
    // Distance (in aisle-order positions) from this aisle to each
    // qualifying zone's own near-end; the MINIMUM across zones wins — a
    // warehouse with two Outbound-serving zones (e.g. an I-shape with
    // BOTH at each end) treats an aisle as close if it's near EITHER one.
    // Direction now comes from the zone's own confirmed numberOneNearDock
    // flag, not a hardcoded EAST=low/WEST=high guess (2026-09-12) — dockSide
    // still says which WALL (for the compass marker/UI), numberOneNearDock
    // says which numbering end sits against it.
    const distances = outboundZones.map((z) => (z.numberOneNearDock ? idx : n - 1 - idx));
    return Math.min(...distances);
  };
}

// Row-axis proximity — step 2 of the 4-wall dock model (2026-09-12). Mirrors
// buildOutboundProximityRanker() exactly, but ranks POSITION WITHIN one
// aisle (which bay/bin along the aisle's own length — Rack's `rack`
// field/Ground's `block` field, the same "position" locationBoxUtils.ts's
// posOf() already establishes on the frontend for the "Rows 1-N" summary)
// rather than which aisle. Real gap this closes: "the furthest bin from the
// dock should be red, closest bin should be green... whats how our ABC_FMS
// calculation should actually work" — a dock can sit on the front/back wall
// of every aisle just as easily as either end of the aisle sequence, and
// nothing measured that axis at all before this.
//
// Deliberately scoped PER CALLER-SUPPLIED GROUP for WHICH POSITION a bin is
// at, not built as one big warehouse-wide ranker like the aisle version —
// a "Row 1..N" sequence is only ever meaningful within ONE (aisle, flank)
// at a time (a mirrored aisle's two flanks even reuse the same underlying
// numbers), so the caller passes in that one group's own already-sorted
// list of distinct positions on every call. BUT the FAR end (NORTH) must
// be measured against a GLOBAL reference point, not each group's own local
// length — a real bug the client caught live (2026-09-12): "if you see
// different aisles, the same row has different colours." Every aisle's
// Row 1 (index 0) anchors to the exact same shared physical line — a
// SOUTH-facing dock already measured this correctly (raw = idx, already
// globally consistent, since index 0 always means the same real depth
// everywhere). But the old NORTH formula (`n - 1 - idx`, using the
// group's OWN length `n`) silently assumed every aisle reaches exactly as
// deep as this one does — so block 01 (the shallowest, globally FARTHEST
// position from a North dock) scored as merely "a bit far" in a short
// 10-block aisle but "maximally far" in a 20-block one, even though
// physically it's the same real depth in both. Callers now pass the
// WAREHOUSE-WIDE longest row sequence (`globalMaxIndex`) alongside each
// call, and NORTH is measured from THAT shared far end
// (`globalMaxIndex - idx`) instead of the local one — an aisle that
// simply doesn't reach as deep as the warehouse's longest one correctly
// never reaches the truly-farthest rank, rather than falsely maxing out
// early.
export function buildRowProximityRanker(dockZones: DockZoneRow[]): ((sortedPositionsInGroup: string[], position: string, globalMaxIndex: number) => number) | null {
  const rowZones = dockZones.filter((z) => (z.purpose === 'OUTBOUND' || z.purpose === 'BOTH') && (z.dockSide === 'SOUTH' || z.dockSide === 'NORTH'));
  if (rowZones.length === 0) return null;
  return (sortedPositionsInGroup: string[], position: string, globalMaxIndex: number): number => {
    const idx = sortedPositionsInGroup.indexOf(position);
    if (idx === -1) return Number.MAX_SAFE_INTEGER;
    // Direction now comes from the zone's own confirmed numberOneNearDock
    // flag, not a hardcoded SOUTH=low/NORTH=high guess (2026-09-12) — see
    // the type comment above and schema.prisma's own comment on
    // WarehouseDockZone.numberOneNearDock for the full reasoning.
    const distances = rowZones.map((z) => (z.numberOneNearDock ? idx : globalMaxIndex - idx));
    return Math.min(...distances);
  };
}

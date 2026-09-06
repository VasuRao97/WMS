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

export type DockZoneRow = { purpose: string; nearAisleEnd: string };

// Builds a function mapping an aisle code -> its outbound-proximity rank
// (lower = closer to whichever end an OUTBOUND/BOTH zone is declared near).
// Returns null when the warehouse has no OUTBOUND-serving zone configured
// at all — callers fall back to today's flankNumber-based proxy in that
// case, so an unconfigured warehouse behaves exactly as it always has.
export function buildOutboundProximityRanker(distinctAisles: string[], dockZones: DockZoneRow[]): ((aisle: string) => number) | null {
  const outboundZones = dockZones.filter((z) => z.purpose === 'OUTBOUND' || z.purpose === 'BOTH');
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
    const distances = outboundZones.map((z) => (z.nearAisleEnd === 'LOW' ? idx : n - 1 - idx));
    return Math.min(...distances);
  };
}

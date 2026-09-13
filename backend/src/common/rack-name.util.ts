// Human "Rack Name" (R{flank}-{rack}-L{level}[-D{depth}]) — the same
// R{flank}-{rack}[-D{depth}] formula LocationsPlanView.tsx uses for the
// Plan View, extended with Level (the Plan View can leave Level out since
// it's shown separately as spatial height; a flat list/label has no such
// context). Returns null for Ground/Stillage or a legacy row with no
// flankNumber yet — Rack Name was only ever built for rack-type storage;
// callers fall back to the raw `code` in that case. Originally a private
// method on PutawayTasksService (2026-08-29, the client's own "R2, not
// R01B" correction); pulled out here once Location Label generation
// needed the exact same formula, per this codebase's "one function, many
// callers" convention rather than a second copy.
// ASRS removed 2026-09-13 — the client's own call: a real ASRS installation
// runs its own dedicated WCS/WES software, so WMS-level bin/rank logic for
// it was always going to be redundant. Confirmed zero real data anywhere
// ever used storageType='ASRS' (a plain free-text field, not a Postgres
// enum, so this needed no schema migration) before removing it — pure code
// cleanup, not a data migration.
export const RACK_STORAGE_TYPES = ['SPR', 'DRIVE_IN'];

export function buildRackName(
  loc:
    | {
        storageType: string;
        flankNumber: number | null;
        rack: string | null;
        level: string | null;
        depth: number | null;
      }
    | null
    | undefined,
): string | null {
  if (
    !loc ||
    !RACK_STORAGE_TYPES.includes(loc.storageType) ||
    loc.flankNumber == null ||
    !loc.rack ||
    !loc.level
  )
    return null;
  const parts = [`R${loc.flankNumber}`, loc.rack, `L${loc.level}`];
  if (loc.depth != null) parts.push(`D${loc.depth}`);
  return parts.join('-');
}

// The label content used for barcodes/scanning display — Rack Name when
// buildable, else the raw code (Ground/Stillage, or a legacy row).
export function displayCode(loc: {
  code: string;
  storageType: string;
  flankNumber: number | null;
  rack: string | null;
  level: string | null;
  depth: number | null;
}): string {
  return buildRackName(loc) ?? loc.code;
}

// Groups Locations into "lanes" — everything sharing one physical
// multi-deep access point (Aisle + flank + Rack + Level for SPR/ASRS;
// Aisle + flank + Rack ACROSS EVERY LEVEL for Drive-in, see below; every
// other row is its own single-location "lane"). Originally a private
// method on PutawayTasksService's suggestBin(); pulled out here 2026-08-29
// once InsightsService needed the exact same grouping to compute per-ABC-
// class storage utilization, per this codebase's "one function, many
// callers" convention. flankNumber MUST be part of the key — on a
// mirrored aisle, R01/R01B are physically separate racks that both store
// the literal rack value "01" (the "B" only ever exists in the display
// code) — see CLAUDE.md's 2026-08-29 flank-merging bug writeup for the
// full story of why this was caught and fixed.
//
// Drive-in drops Level from the key (2026-09-02, see CLAUDE.md's Putaway
// section) — a whole Drive-in column, ground to top, is one physical
// single-SKU access unit: an MHE drives in from one opening and can't dig
// past stock at one level to reach a different SKU buried at another
// level. SPR/ASRS are unchanged — each level there IS independently
// addressable (a Reach/Stacker truck accesses any level from the aisle
// without disturbing the others), so they keep Level in the key exactly
// as before this date.
//
// STILLAGE (2026-09-13, added once Stillage's own redesign gave it a real
// column/depth lane model equivalent to Rack's) — a lane is one COLUMN
// (`stack` + `rack`, `rack` reused as the column number within the bin,
// same convention Ground's own redesign already established), single-file
// LIFO, `depth` positions deep — mechanically identical to a Rack lane,
// just naming a stack instead of a rack row. Ground/Floor is deliberately
// NOT included here even though its own redesign gave it the same
// column/depth shape — nothing has asked to extend this grouping (or its
// only consumer, InsightsService's storage-utilization report) to Ground,
// so it stays out rather than silently bundled in.
export function laneKeyOf(loc: {
  id: string;
  storageType: string;
  aisle: string | null;
  rack: string | null;
  level: string | null;
  flankNumber: number | null;
  stack?: string | null;
}): string {
  if (loc.storageType === 'STILLAGE') {
    return loc.aisle && loc.stack && loc.rack
      ? `${loc.aisle}|${loc.flankNumber ?? 'x'}|${loc.stack}|${loc.rack}`
      : `single|${loc.id}`;
  }
  if (!RACK_STORAGE_TYPES.includes(loc.storageType) || !loc.aisle || !loc.rack)
    return `single|${loc.id}`;
  if (loc.storageType === 'DRIVE_IN')
    return `${loc.aisle}|${loc.flankNumber ?? 'x'}|${loc.rack}`;
  return loc.level
    ? `${loc.aisle}|${loc.flankNumber ?? 'x'}|${loc.rack}|${loc.level}`
    : `single|${loc.id}`;
}

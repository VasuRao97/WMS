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
export const RACK_STORAGE_TYPES = ['SPR', 'DRIVE_IN', 'ASRS'];

export function buildRackName(loc: { storageType: string; flankNumber: number | null; rack: string | null; level: string | null; depth: number | null } | null | undefined): string | null {
  if (!loc || !RACK_STORAGE_TYPES.includes(loc.storageType) || loc.flankNumber == null || !loc.rack || !loc.level) return null;
  const parts = [`R${loc.flankNumber}`, loc.rack, `L${loc.level}`];
  if (loc.depth != null) parts.push(`D${loc.depth}`);
  return parts.join('-');
}

// The label content used for barcodes/scanning display — Rack Name when
// buildable, else the raw code (Ground/Stillage, or a legacy row).
export function displayCode(loc: { code: string; storageType: string; flankNumber: number | null; rack: string | null; level: string | null; depth: number | null }): string {
  return buildRackName(loc) ?? loc.code;
}

// Groups Locations into "lanes" — everything sharing one physical
// multi-deep access point (Aisle + flank + Rack + Level for rack storage;
// every other row is its own single-location "lane"). Originally a
// private method on PutawayTasksService's suggestBin(); pulled out here
// 2026-08-29 once InsightsService needed the exact same grouping to
// compute per-ABC-class storage utilization, per this codebase's "one
// function, many callers" convention. flankNumber MUST be part of the key
// — on a mirrored aisle, R01/R01B are physically separate racks that both
// store the literal rack value "01" (the "B" only ever exists in the
// display code) — see CLAUDE.md's 2026-08-29 flank-merging bug writeup
// for the full story of why this was caught and fixed.
export function laneKeyOf(loc: { id: string; storageType: string; aisle: string | null; rack: string | null; level: string | null; flankNumber: number | null }): string {
  return RACK_STORAGE_TYPES.includes(loc.storageType) && loc.aisle && loc.rack && loc.level
    ? `${loc.aisle}|${loc.flankNumber ?? 'x'}|${loc.rack}|${loc.level}`
    : `single|${loc.id}`;
}

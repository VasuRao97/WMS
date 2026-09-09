// Occupancy overlay color palettes (2026-09-05 — see [[wms-putaway-design]]).
// Shared by LocationsPlanView.tsx (2D) and Locations3DView.tsx (3D) so both
// views use the identical color language, same "one function/palette, many
// callers" convention as STORAGE_TYPE_COLORS itself.
//
// Two independent coloring modes, confirmed directly with the client rather
// than assumed: "By Category" (each product Category its own color) and
// "By Class" (A/B/C its own color) — a mode swap alongside today's default
// "Structural" (storageType) coloring, never blended with it. An EMPTY
// location (nothing in `Occupancy` for it) always renders NEUTRAL in either
// mode, confirmed directly — only occupied bins get a category/class color.

export type Occupancy = {
  locationId: string;
  skuId: string;
  skuCode: string | null;
  categoryId: string | null;
  categoryName: string | null;
  abcClass: 'A' | 'B' | 'C';
  // FMS (Fast/Medium/Slow-moving) — 2026-09-08, a genuinely different axis
  // from abcClass above (movement frequency, not quantity/value). Unlike
  // abcClass, which always has a value (falls back to 'C' when unclassified
  // — see occupancyByWarehouse()'s own comment), fmsClass has no such
  // fallback: null means either the occupant SKU is ABC-class D (no FMS
  // lookup — suggestBin() treats D as CS regardless), or FMS classification
  // simply hasn't been run for this warehouse yet. Both render NEUTRAL in
  // "By FMS Class" mode, same as an empty location — there's no meaningful
  // color to invent for "unknown."
  fmsClass?: 'F' | 'M' | 'S' | null;
  // On-hand quantity at this location (2026-09-06 — click-to-inspect gained
  // SKU details, "I need SKU details in it also") — optional so this type
  // still fits data that predates the field (none currently does, but no
  // caller is forced to supply it either).
  quantity?: number;
};

export type ColorMode = 'structural' | 'category' | 'class' | 'fmsClass' | 'priority' | 'binRank';

export const NEUTRAL_COLOR = { fill: '#f3f4f6', stroke: '#9ca3af' };

// A/B/C — traffic-light convention (A = fastest-moving/highest-priority =
// green, C = slowest = red), matching the intuitive mental model this kind
// of classification usually carries.
export const ABC_CLASS_COLORS: Record<'A' | 'B' | 'C', { fill: string; stroke: string }> = {
  A: { fill: '#dcfce7', stroke: '#16a34a' },
  B: { fill: '#fef3c7', stroke: '#d97706' },
  C: { fill: '#fee2e2', stroke: '#dc2626' },
};

// F/M/S (2026-09-08) — its own separate scale, never confused with ABC's
// (blue for S rather than reusing ABC's red for C) — same color choice
// AbcClassificationPage.tsx already uses for this axis.
export const FMS_CLASS_COLORS: Record<'F' | 'M' | 'S', { fill: string; stroke: string }> = {
  F: { fill: '#dcfce7', stroke: '#16a34a' },
  M: { fill: '#fef3c7', stroke: '#d97706' },
  S: { fill: '#dbeafe', stroke: '#2563eb' },
};

// Combined ABC×FMS priority score, "By Priority Gradient" mode (2026-09-09
// — see [[wms-abc-velocity-design]] in memory). Ground's own placement
// mechanism (suggestGroundBin() in putaway-tasks.service.ts) — Ground has
// only one physical lever (aisle/dock proximity, no vertical level concept
// the way Rack has), so FMS blends into the SAME score ABC already drives
// rather than getting its own independent lever. This is a byte-identical
// mirror of PutawayTasksService.combinedPriorityScore() on the backend —
// duplicated rather than shared, same "no shared package between frontend/
// backend" convention as every other cross-cutting pure function in this
// codebase (e.g. buildRackName's own frontend/backend copies). Keep both in
// sync if the scoring formula ever changes.
export function combinedPriorityScore(abcClass: string, fmsClass: string | null | undefined): number {
  if (abcClass === 'D') return 6;
  const abcRank = abcClass === 'A' ? 1 : abcClass === 'B' ? 2 : 3;
  const fmsRank = fmsClass === 'F' ? 1 : fmsClass === 'M' ? 2 : fmsClass === 'S' ? 3 : abcRank;
  return abcRank + fmsRank;
}

// 2 (AF, the best possible score) down to 6 (CS/D, the worst) mapped onto a
// continuous green→yellow→red HSL gradient — confirmed directly: "colour
// gradient for it, green being A-F slowlly moving to yellow then red." A
// gradient, not a fixed lookup table, is the whole point here — this mode
// exists specifically to let you SEE whether Ground placement is actually
// respecting the combined score (green bins clustering near outbound, red
// bins clustering far), which a handful of discrete buckets would obscure.
export function priorityGradientColor(occ: Occupancy): { fill: string; stroke: string } {
  const score = combinedPriorityScore(occ.abcClass, occ.fmsClass);
  const t = (score - 2) / 4; // 0 = best (green) .. 1 = worst (red)
  const hue = 120 - t * 120; // 120=green, 60=yellow (the score=4 midpoint), 0=red
  return { fill: `hsl(${hue}, 70%, 88%)`, stroke: `hsl(${hue}, 65%, 45%)` };
}

// Bin Rank, "By Bin Rank" mode (2026-09-09) — genuinely different from
// every mode above: LOCATION-INTRINSIC (no occupancy or SKU involved at
// all), and a discrete 1-9 NUMBER shown as text on the bin itself, not
// just a color. Confirmed directly, multiple rounds of clarifying this was
// NOT the same thing as the (removed) "Dock Proximity" mode: "i mean, yes?
// ... first number ranking, then make the pallet colour in the gradient
// type. so i know which ranked 1 2 3 -- 9 .. idc if the bin is used or
// not, i just wanna know our bin ranking." The number IS the 9-cell
// ABC×FMS matrix itself (1=AF best .. 9=CS worst, row-major — the same
// order the whole FMS×ABC design already uses), not a disconnected
// geometry number the way the removed mode was — the actual fix for why
// that one didn't register as "the ABC-FMS thing."
export const BIN_RANK_MATRIX_LABELS = ['AF', 'AM', 'AS', 'BF', 'BM', 'BS', 'CF', 'CM', 'CS'];

// Scoped to Ground/Floor only (see LocationsService.binRankByWarehouse()'s
// own comment for why — Rack splits ABC/FMS across two independent levers,
// so a single number per bin wouldn't honestly represent a Rack position).
export type BinRank = { configured: boolean; ranks: { aisle: string; rank: number; label: string }[] };

// Same green→yellow→red HSL gradient formula as Priority Gradient's own
// (combinedPriorityScore-driven) coloring, just mapped onto the 1-9 range
// instead of the 2-6 one — 1 (AF, best) is green, 9 (CS, worst) is red.
export function binRankColor(rank: number): { fill: string; stroke: string } {
  const t = (rank - 1) / 8; // 0 = best (green) .. 1 = worst (red)
  const hue = 120 - t * 120;
  return { fill: `hsl(${hue}, 70%, 88%)`, stroke: `hsl(${hue}, 65%, 45%)` };
}

// Categories are open-ended (however many a company has created) — a fixed
// rotating palette assigned by sorted category name, so the same category
// always gets the same color across a session (deterministic, not random)
// without needing per-category color configuration anywhere.
const CATEGORY_PALETTE: { fill: string; stroke: string }[] = [
  { fill: '#dbeafe', stroke: '#2563eb' }, // blue
  { fill: '#fee2e2', stroke: '#dc2626' }, // red
  { fill: '#dcfce7', stroke: '#16a34a' }, // green
  { fill: '#fef3c7', stroke: '#d97706' }, // amber
  { fill: '#ede9fe', stroke: '#7c3aed' }, // purple
  { fill: '#fce7f3', stroke: '#db2777' }, // pink
  { fill: '#cffafe', stroke: '#0891b2' }, // cyan
  { fill: '#ffedd5', stroke: '#ea580c' }, // orange
  { fill: '#e0e7ff', stroke: '#4f46e5' }, // indigo
  { fill: '#d1fae5', stroke: '#059669' }, // emerald
  { fill: '#fae8ff', stroke: '#a21caf' }, // fuchsia
  { fill: '#fef9c3', stroke: '#ca8a04' }, // yellow
];

// Assigns each distinct categoryId a stable color by its position in the
// sorted-by-name category list — computed once per render from whatever
// categories actually appear in the current occupancy data, not a global
// fixed mapping (so a warehouse with 3 categories doesn't burn through
// unrelated colors reserved for categories it doesn't have).
export function buildCategoryColorMap(occupancy: Occupancy[]): Map<string, { fill: string; stroke: string }> {
  const byId = new Map<string, string>();
  for (const o of occupancy) {
    if (o.categoryId && !byId.has(o.categoryId)) byId.set(o.categoryId, o.categoryName || o.categoryId);
  }
  const sorted = [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const map = new Map<string, { fill: string; stroke: string }>();
  sorted.forEach(([categoryId], i) => map.set(categoryId, CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]));
  return map;
}

// The single lookup both views call per-box: given the current mode, the
// occupancy row for this location (if any), and the category color map,
// return the color to actually render — or null when the caller should
// fall back to its own default (structural mode, or "occupancy mode but no
// occupancy data loaded yet").
export function occupancyColorFor(
  mode: ColorMode,
  occ: Occupancy | undefined,
  categoryColors: Map<string, { fill: string; stroke: string }>,
): { fill: string; stroke: string } | null {
  if (mode === 'structural') return null;
  if (!occ) return NEUTRAL_COLOR;
  if (mode === 'class') return ABC_CLASS_COLORS[occ.abcClass] || NEUTRAL_COLOR;
  if (mode === 'fmsClass') return (occ.fmsClass && FMS_CLASS_COLORS[occ.fmsClass]) || NEUTRAL_COLOR;
  if (mode === 'priority') return priorityGradientColor(occ);
  if (occ.categoryId) return categoryColors.get(occ.categoryId) || NEUTRAL_COLOR;
  return NEUTRAL_COLOR;
}

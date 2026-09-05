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
};

export type ColorMode = 'structural' | 'category' | 'class';

export const NEUTRAL_COLOR = { fill: '#f3f4f6', stroke: '#9ca3af' };

// A/B/C — traffic-light convention (A = fastest-moving/highest-priority =
// green, C = slowest = red), matching the intuitive mental model this kind
// of classification usually carries.
export const ABC_CLASS_COLORS: Record<'A' | 'B' | 'C', { fill: string; stroke: string }> = {
  A: { fill: '#dcfce7', stroke: '#16a34a' },
  B: { fill: '#fef3c7', stroke: '#d97706' },
  C: { fill: '#fee2e2', stroke: '#dc2626' },
};

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
  if (occ.categoryId) return categoryColors.get(occ.categoryId) || NEUTRAL_COLOR;
  return NEUTRAL_COLOR;
}

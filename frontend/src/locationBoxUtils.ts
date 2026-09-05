import type { Location } from './LocationsPage';

// Small, pure helpers shared by every Plan View surface that groups
// Locations into boxes — LocationsPlanView.tsx (2D), Locations3DView.tsx
// (3D), and LocationDetailPanel.tsx (the click-to-inspect panel both share).
// Extracted 2026-09-06 (hardening pass) after all three files ended up with
// byte-identical copies of these three functions — the 2D/3D views'
// higher-level layout builders (buildCell/buildLayout vs.
// buildBoxesForAisle/buildWarehouseLayout) are deliberately NOT shared
// (they produce genuinely different shapes — 2D screen-space boxes vs. 3D
// world-space boxes), but these three primitives are plain, generic
// Location/string utilities with zero difference between callers — same
// "one function, many callers" convention this codebase already applies
// on the backend (see CLAUDE.md).

// Which field holds a Location's "position" within its aisle/flank depends
// on storageType — Rack uses `rack`, Ground/Floor uses `block`, Stillage
// uses `stack`.
export function posOf(l: Location): string | undefined {
  if (l.storageType === 'GROUND_FLOOR') return l.block;
  if (l.storageType === 'STILLAGE') return l.stack;
  return l.rack;
}

// Numeric-aware sort so "2" < "10" instead of the default lexical "10" < "2".
export function naturalCompare(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (a.trim() !== '' && b.trim() !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a.localeCompare(b);
}

export function uniqSorted(values: (string | undefined)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v))).sort(naturalCompare);
}

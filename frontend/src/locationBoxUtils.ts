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
// on storageType — Stillage uses `stack`; Rack AND Ground/Floor both key off
// `rack`, since Ground's `rack` field is deliberately reused as its own
// COLUMN number, sharing the exact same single-file-LIFO-lane meaning
// `depth` already has with Rack (see schema.prisma's comment on
// `Location.rack`/`Location.depth`) — a Ground column is structurally the
// same kind of thing as a Rack bay, not a Rack concept forced onto Ground.
// A block (bin) groups several columns together the way an Aisle groups
// several bays; it isn't itself a "position" (2026-09-06, a real client
// correction — "how is this 4x4? looks like 1x4... dont keep your rack as
// ideal, we need to align separately": an earlier version treated a whole
// BLOCK as one position and just stretched its box wider to suggest more
// pallets, which never actually looked like a real 4×4 grid — a genuine
// grid needs both axes shown as real positions, not one axis text and the
// other a stretched box). `block~column` is returned as one composite key
// (column zero-padded so "10" sorts after "9", not before "2" as a raw
// string) so multiple blocks sharing the same column numbers stay distinct
// — see `buildCell`'s (2D) and `buildBoxesForAisle`'s (3D) GROUND_FLOOR
// branches for how each column then renders exactly like a Rack bay does.
export function posOf(l: Location): string | undefined {
  if (l.storageType === 'STILLAGE') return l.stack;
  if (l.storageType === 'GROUND_FLOOR') {
    if (l.block == null || l.rack == null) return undefined;
    return `${l.block}~${l.rack.padStart(4, '0')}`;
  }
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

import { RACK_STORAGE_TYPES, STORAGE_TYPE_OPTIONS, labelFor, type Location } from './LocationsPage';

// Top-down structural floor-plan view of one warehouse's Locations — built
// after a dedicated design conversation (see CLAUDE.md's Locations/Bins
// notes once documented). Static/structural only: shows which bins EXIST,
// not what's in them (no occupancy — Inbound/Putaway don't exist yet).
//
// Layout rules agreed in that conversation:
// - One vertical "aisle" strip per distinct Aisle value, aisles laid out
//   left-to-right in ascending Aisle-code order.
// - Within one aisle, which flank a row belongs to comes from the real,
//   persisted `side` field (set only by the range generator — see
//   schema.prisma's comment on Location.side and LocationsService.generate)
//   — NOT guessed from the rack/block numbers. An earlier version of this
//   view split every aisle's numbers at the midpoint and assumed two
//   flanks always exist; that was wrong — an aisle generated with a single
//   Rack Range (no Second Range) is genuinely single-sided (e.g. racking
//   against a wall), and guessing invented a second flank that didn't
//   exist, duplicating the same content on both sides. Now: no row in an
//   aisle has `side: 'B'` → everything renders in ONE flank (the right).
//   Some rows do → those are the real second flank (left), the rest (blank
//   `side`) are the primary/right flank.
// - Rows pair by POSITION, not by raw number — the 1st position on the
//   right flank (nearest the corner) is drawn in the same row as the 1st
//   position on the left flank, regardless of what their stored numbers
//   actually are ("1 opposite 1"). This still applies even when both
//   flanks reuse the same rack/block numbers (a "mirror" generation) —
//   their codes stay unique via a side-letter suffix, but the numbers
//   themselves can be identical.
// - Every footprint cell (one Rack, one Ground block, one Stillage stack)
//   is drawn the same fixed size — Level range / Depth / dimensions are
//   shown as TEXT inside the cell, not as a wider box. Simple and legible;
//   can switch to proportional sizing later if that stops being enough.
// - Zone Type coloring is deliberately not built yet (parked for later).

const CELL_W = 110;
const CELL_H = 60;
const ROW_GAP = 6;
const WALKWAY_W = 34;
const AISLE_GAP = 36;
const PAD_TOP = 34;
const PAD_BOTTOM = 16;
const PAD_X = 16;

// Numeric-aware sort so "2" < "10" instead of the default lexical "10" < "2".
function naturalCompare(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (a.trim() !== '' && b.trim() !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a.localeCompare(b);
}

function uniqSorted(values: (string | undefined)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v))).sort(naturalCompare);
}

function posOf(l: Location): string | undefined {
  if (l.storageType === 'GROUND_FLOOR') return l.block;
  if (l.storageType === 'STILLAGE') return l.stack;
  return l.rack;
}

type Cell = {
  posVal: string;
  lines: string[];
  hasInactive: boolean;
  key: string;
};

function buildCell(posVal: string, rows: Location[]): Cell {
  const storageType = rows[0].storageType;
  const lines: string[] = [labelFor(STORAGE_TYPE_OPTIONS, storageType)];

  if (RACK_STORAGE_TYPES.includes(storageType)) {
    const depths = uniqSorted(rows.map((r) => (r.depth != null ? String(r.depth) : undefined)));
    if (depths.length > 1) lines.push(`Depth ${depths[0]}-${depths[depths.length - 1]}`);
    const levels = uniqSorted(rows.map((r) => r.level));
    if (levels.length === 1) lines.push(`L${levels[0]}`);
    else if (levels.length > 1) lines.push(`L${levels[0]}-L${levels[levels.length - 1]}`);
  } else {
    const d = rows[0].depth ?? 1;
    const w = rows[0].width ?? 1;
    const h = rows[0].height ?? 1;
    lines.push(`${d}×${w}×${h}`);
  }
  lines.push(rows.length === 1 ? rows[0].code : `${rows.length} bins`);

  return { posVal, lines, hasInactive: rows.some((r) => !r.isActive), key: rows[0].id };
}

type AisleBlock = {
  aisleCode: string;
  rightCells: Cell[];
  leftCells: Cell[];
};

function buildLayout(locations: Location[]): { aisles: AisleBlock[]; skipped: number } {
  const withAisle = locations.filter((l) => l.aisle);
  const skipped = locations.length - withAisle.length;

  const byAisle = new Map<string, Location[]>();
  for (const l of withAisle) {
    const key = l.aisle!;
    if (!byAisle.has(key)) byAisle.set(key, []);
    byAisle.get(key)!.push(l);
  }

  const aisleCodes = Array.from(byAisle.keys()).sort(naturalCompare);
  const aisles: AisleBlock[] = aisleCodes.map((aisleCode) => {
    const aisleLocs = byAisle.get(aisleCode)!;
    // Real signal, not a guess: only a row generated from a Second Range (or
    // the "mirror" checkbox) ever has side === 'B'. No such row in this
    // aisle means it's genuinely single-sided — draw one flank, not two.
    const primaryLocs = aisleLocs.filter((l) => l.side !== 'B');
    const secondaryLocs = aisleLocs.filter((l) => l.side === 'B');
    const rightPos = uniqSorted(primaryLocs.map(posOf));
    const leftPos = uniqSorted(secondaryLocs.map(posOf));

    const cellFor = (rows: Location[]) => (posVal: string) => buildCell(posVal, rows.filter((l) => posOf(l) === posVal));
    return {
      aisleCode,
      rightCells: rightPos.map(cellFor(primaryLocs)),
      leftCells: leftPos.map(cellFor(secondaryLocs)),
    };
  });

  return { aisles, skipped };
}

function AisleCellBox({ cell, x, y }: { cell: Cell; x: number; y: number }) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={CELL_W}
        height={CELL_H}
        fill={cell.hasInactive ? '#f3f3f3' : '#ffffff'}
        stroke="#333"
        strokeWidth={1}
        strokeDasharray={cell.hasInactive ? '4 3' : undefined}
      />
      {cell.lines.map((line, i) => (
        <text
          key={i}
          x={x + CELL_W / 2}
          y={y + 16 + i * 13}
          textAnchor="middle"
          fontSize={10.5}
          fill={cell.hasInactive ? '#999' : '#222'}
          fontFamily="sans-serif"
        >
          {line}
        </text>
      ))}
    </g>
  );
}

function LocationsPlanView({ locations, warehouseLabel }: { locations: Location[]; warehouseLabel: string }) {
  if (locations.length === 0) {
    return <p style={{ marginTop: 16 }}>No locations in this warehouse yet — generate or import some first.</p>;
  }

  const { aisles, skipped } = buildLayout(locations);
  if (aisles.length === 0) {
    return <p style={{ marginTop: 16 }}>None of this warehouse's {locations.length} location(s) have an Aisle set — nothing to plot.</p>;
  }

  const maxRows = Math.max(...aisles.map((a) => Math.max(a.rightCells.length, a.leftCells.length)));
  const rowBandH = CELL_H + ROW_GAP;
  const totalHeight = PAD_TOP + maxRows * rowBandH + PAD_BOTTOM;
  const aisleBlockW = CELL_W * 2 + WALKWAY_W;
  const totalWidth = PAD_X * 2 + aisles.length * aisleBlockW + (aisles.length - 1) * AISLE_GAP;

  // Row 0 (nearest the bottom-right reference corner) always sits on the
  // bottom line, shared across every aisle — a taller aisle just extends
  // further up rather than floating independently.
  const yForRow = (rowIndex: number) => PAD_TOP + (maxRows - 1 - rowIndex) * rowBandH;

  return (
    <div>
      <p style={{ fontSize: 12, color: '#666', marginTop: 4, marginBottom: 12 }}>
        <strong>{warehouseLabel}</strong> — {aisles.length} aisle(s), structural layout only (no occupancy).
        A single-sided aisle draws as one flank on the right; a second flank (left) only appears when it was actually
        generated (a Second Range, or the "mirror" checkbox) — never guessed. Rows pair by position, not by raw
        number. {skipped > 0 ? `${skipped} location(s) with no Aisle set are not shown.` : ''}
      </p>
      <div style={{ overflow: 'auto', border: '1px solid #ddd', borderRadius: 8, padding: 8 }}>
        <svg width={totalWidth} height={totalHeight} viewBox={`0 0 ${totalWidth} ${totalHeight}`}>
          {aisles.map((aisle, i) => {
            const aisleX = PAD_X + i * (aisleBlockW + AISLE_GAP);
            const leftX = aisleX;
            const walkwayX = aisleX + CELL_W;
            const rightX = walkwayX + WALKWAY_W;
            return (
              <g key={aisle.aisleCode}>
                <rect x={walkwayX} y={PAD_TOP} width={WALKWAY_W} height={maxRows * rowBandH - ROW_GAP} fill="#a9a9a9" />
                <text
                  x={walkwayX + WALKWAY_W / 2}
                  y={PAD_TOP - 10}
                  textAnchor="middle"
                  fontSize={12}
                  fontWeight="bold"
                  fontFamily="sans-serif"
                  fill="#222"
                >
                  {aisle.aisleCode}
                </text>
                {aisle.leftCells.map((cell, r) => (
                  <AisleCellBox key={cell.key} cell={cell} x={leftX} y={yForRow(r)} />
                ))}
                {aisle.rightCells.map((cell, r) => (
                  <AisleCellBox key={cell.key} cell={cell} x={rightX} y={yForRow(r)} />
                ))}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

export default LocationsPlanView;

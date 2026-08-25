import { RACK_STORAGE_TYPES, STORAGE_TYPE_OPTIONS, labelFor, type Location } from './LocationsPage';

// Top-down structural floor-plan view of one warehouse's Locations — built
// after a dedicated design conversation (see CLAUDE.md's Locations/Bins
// notes once documented). Static/structural only: shows which bins EXIST,
// not what's in them (no occupancy — Inbound/Putaway don't exist yet).
//
// Layout rules agreed in that conversation:
// - One vertical "aisle" strip per distinct Aisle value. Everything anchors
//   to a bottom-RIGHT reference corner: Aisle 1 (lowest code) sits closest
//   to that corner, and each next aisle is added to its LEFT — the picture
//   grows away from the corner, same direction the row/flank numbering
//   already grows in. (An earlier version added new aisles to the right,
//   which was backwards from this — caught and fixed 2026-08-25.)
// - Within one aisle, which flank a row belongs to comes from the real,
//   persisted `flankNumber` field (set only by the range generator — see
//   schema.prisma's comment on Location.flankNumber and
//   LocationsService.resolveFlankNumber) — NOT guessed from the rack/block
//   numbers. Two design passes landed on this, in order: first, an early
//   version split every aisle's numbers at the midpoint and assumed two
//   flanks always exist — wrong, since a single Rack Range with no Second
//   Range is genuinely single-sided (e.g. racking against a wall), and
//   guessing invented a second flank that didn't exist. That was fixed with
//   a `side` flag ('B'/blank). Then `side` itself was retired in favor of
//   `flankNumber` (2026-08-25) — a real, globally-unique-per-warehouse
//   number rather than just a local primary/secondary flag, because the
//   number itself needed to be stored and referenceable (Putaway/Pick logic,
//   not just this picture — see "Rack Name" below). Within one aisle: at
//   most two distinct flank numbers exist, the LOWER is the right/primary
//   flank, the higher (if present) is the left/secondary flank — derived by
//   comparison, nothing guessed from the rack/block numbers themselves.
// - Rows pair by POSITION, not by raw number — the 1st position on the
//   right flank (nearest the corner) is drawn in the same row as the 1st
//   position on the left flank, regardless of what their stored numbers
//   actually are ("1 opposite 1"). This still applies even when both
//   flanks reuse the same rack/block numbers (a "mirror" generation) —
//   their codes stay unique via a flank-letter suffix, but the numbers
//   themselves can be identical.
// - "Rack Name" — each Rack box's label is `R{flankNumber}-{rack}[-D{depth}]`
//   (e.g. `R1-04`, or `R1-04-D2` for the 2nd position in a multi-deep lane)
//   — a real, physical-signage-style name built from `flankNumber` (this
//   flank's own global number) + the rack position + which depth this
//   specific box is, replacing the old verbose storage-type text. Level
//   isn't part of it — a top-down plan can't spatially show height, so
//   Level stays as separate smaller text below the name, same as before,
//   rather than being baked into the label itself.
// - A Rack position with more than one Depth draws as that many boxes side
//   by side — one box per real position in the lane, since each depth
//   position genuinely is a separate Location row (2026-08-25: an earlier
//   version showed one fixed-size box with "Depth 1-3" as text, which read
//   as a single pallet even for a 3-deep lane — corrected to show the real
//   count). Ground/Floor and Stillage still show depth/width/height as text
//   in one box for now — their depth is a dimension on one single row, not
//   multiple separate rows the way Rack's is, and whether they should also
//   get real sub-boxes is a separate, still-open question.
// - Zone Type coloring is deliberately not built yet (parked for later).

const CELL_W = 110;
const CELL_H = 60;
const ROW_GAP = 6;
const WALKWAY_W = 34;
const AISLE_GAP = 36;
const PAD_TOP = 46;
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

// Real-world building/racking convention (Ground, then G+1, G+2...) instead
// of L1/L2 — Level 1 is ground level itself, everything above counts up
// from there. Confirmed 2026-08-25.
function levelLabel(levelNum: number): string {
  return levelNum === 1 ? 'G' : `G+${levelNum - 1}`;
}

// A rack position's level line: a single level shows just its own label
// (`G`, `G+2`...). A contiguous range starting at ground shows only the TOP
// — "goes up to G+3" implies it starts at G, no need to say both ends. A
// range that doesn't start at ground (rare — a rack missing its lowest
// level) falls back to showing both ends rather than silently dropping
// that it's not a from-the-floor stack.
function levelRangeLabel(levels: string[]): string | undefined {
  if (levels.length === 0) return undefined;
  const nums = levels.map((l) => parseInt(l, 10)).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  if (nums.length === 0) return undefined;
  if (nums.length === 1) return levelLabel(nums[0]);
  const min = nums[0];
  const max = nums[nums.length - 1];
  if (min === 1) return levelLabel(max);
  return `${levelLabel(min)}-${levelLabel(max)}`;
}

function posOf(l: Location): string | undefined {
  if (l.storageType === 'GROUND_FLOOR') return l.block;
  if (l.storageType === 'STILLAGE') return l.stack;
  return l.rack;
}

// One footprint position (a Rack, a Ground block, a Stillage stack) can draw
// as more than one box — a multi-deep Rack lane draws one box per depth
// position, side by side. `totalWidth` is the sum of all its boxes' widths,
// used to size the flank column that holds it.
type Box = {
  key: string;
  lines: string[];
  hasInactive: boolean;
  width: number;
  storageType: string;
};

// One fill/border colour per Storage Type, so the shape of the layout is
// readable at a glance without reading every box's text — confirmed
// 2026-08-25. Light pastel fills keep the black text legible; an inactive
// box overrides this with the existing grey/dashed treatment (that signal
// stays distinct from storage type, not blended into it).
const STORAGE_TYPE_COLORS: Record<string, { fill: string; stroke: string }> = {
  SPR: { fill: '#dbeafe', stroke: '#2563eb' },
  DRIVE_IN: { fill: '#ede9fe', stroke: '#7c3aed' },
  ASRS: { fill: '#ccfbf1', stroke: '#0d9488' },
  GROUND_FLOOR: { fill: '#ffedd5', stroke: '#ea580c' },
  STILLAGE: { fill: '#fce7f3', stroke: '#db2777' },
};
const DEFAULT_BOX_COLOR = { fill: '#ffffff', stroke: '#333' };

type Cell = {
  posVal: string;
  boxes: Box[];
  totalWidth: number;
};

function buildCell(posVal: string, rows: Location[]): Cell {
  const storageType = rows[0].storageType;
  const typeLabel = labelFor(STORAGE_TYPE_OPTIONS, storageType);

  if (RACK_STORAGE_TYPES.includes(storageType)) {
    // Group by depth (missing depth ~= a single-deep position, i.e. one
    // implicit "depth 1") so a plain SPR rack still draws as one box, same
    // as before — only a genuine multi-deep lane (Drive-in with >1 real
    // depth row) gets split into several.
    const depthKey = (r: Location) => (r.depth != null ? String(r.depth) : '1');
    const depths = uniqSorted(rows.map(depthKey));
    const boxes: Box[] = depths.map((d) => {
      const atDepth = rows.filter((r) => depthKey(r) === d);
      const levels = uniqSorted(atDepth.map((r) => r.level));
      // "Rack Name" — see the file-level comment above. Full format on
      // every box (R1-04-D2), even though the flank number also gets its
      // own callout above the whole column — that's an addition for
      // scanning the column at a glance, not a replacement for the
      // per-box identity (confirmed 2026-08-25, an earlier version wrongly
      // dropped the R-prefix from every box when the callout was added).
      const flank = atDepth[0].flankNumber;
      const rackName = [flank != null ? `R${flank}` : 'R?', posVal, depths.length > 1 ? `D${d}` : null].filter(Boolean).join('-');
      const lines = [rackName];
      const levelLine = levelRangeLabel(levels);
      if (levelLine) lines.push(levelLine);
      // Category, not a "N bins" count — that count was really just "how
      // many Levels got collapsed into this one box" (a top-down plan can't
      // show them separately), which read as confusingly close to the
      // actual Bin field. Category tells you what's actually meant to be
      // stored here, which is more useful at a glance. Confirmed 2026-08-25.
      const category = atDepth[0].category?.name;
      if (category) lines.push(category);
      return { key: atDepth[0].id, lines, hasInactive: atDepth.some((r) => !r.isActive), width: CELL_W, storageType };
    });
    return { posVal, boxes, totalWidth: boxes.reduce((s, b) => s + b.width, 0) };
  }

  // Ground/Floor and Stillage: still one box, dimensions as text — see the
  // file-level comment above on why this stays deferred for now.
  const d = rows[0].depth ?? 1;
  const w = rows[0].width ?? 1;
  const h = rows[0].height ?? 1;
  const lines = [typeLabel, `${d}×${w}×${h}`, rows.length === 1 ? rows[0].code : `${rows.length} bins`];
  const box: Box = { key: rows[0].id, lines, hasInactive: rows.some((r) => !r.isActive), width: CELL_W, storageType };
  return { posVal, boxes: [box], totalWidth: CELL_W };
}

type AisleBlock = {
  aisleCode: string;
  section?: string;
  rightFlankNumber?: number;
  leftFlankNumber?: number;
  rightCells: Cell[];
  leftCells: Cell[];
  maxRightW: number;
  maxLeftW: number;
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
    // Real signal, not a guess: at most two distinct flankNumber values
    // exist per aisle (see LocationsService.resolveFlankNumber) — the
    // LOWER one is the primary/right flank, the HIGHER one (if present) is
    // the secondary/left flank. Rows with no flankNumber at all (data from
    // before this field existed) fall back into the primary flank rather
    // than being dropped, so old data still renders (single-flank) instead
    // of vanishing.
    const distinctFlanks = Array.from(new Set(aisleLocs.map((l) => l.flankNumber).filter((f): f is number => f != null))).sort((a, b) => a - b);
    const [primaryFlank, secondaryFlank] = distinctFlanks;
    const primaryLocs = aisleLocs.filter((l) => l.flankNumber == null || l.flankNumber === primaryFlank);
    const secondaryLocs = secondaryFlank != null ? aisleLocs.filter((l) => l.flankNumber === secondaryFlank) : [];
    const rightPos = uniqSorted(primaryLocs.map(posOf));
    const leftPos = uniqSorted(secondaryLocs.map(posOf));

    const cellFor = (rows: Location[]) => (posVal: string) => buildCell(posVal, rows.filter((l) => posOf(l) === posVal));
    const rightCells = rightPos.map(cellFor(primaryLocs));
    const leftCells = leftPos.map(cellFor(secondaryLocs));
    // Section is a hard 1:1-with-Aisle invariant enforced server-side (see
    // assertSectionConsistency in locations.service.ts) — every row here is
    // guaranteed to agree, so the first one found is authoritative.
    const section = aisleLocs.find((l) => l.section)?.section;
    return {
      aisleCode,
      section,
      rightFlankNumber: primaryFlank,
      leftFlankNumber: secondaryFlank,
      rightCells,
      leftCells,
      maxRightW: Math.max(CELL_W, ...rightCells.map((c) => c.totalWidth)),
      maxLeftW: Math.max(CELL_W, ...leftCells.map((c) => c.totalWidth)),
    };
  });

  return { aisles, skipped };
}

function AisleCellBox({ box, x, y }: { box: Box; x: number; y: number }) {
  const color = STORAGE_TYPE_COLORS[box.storageType] || DEFAULT_BOX_COLOR;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={box.width}
        height={CELL_H}
        fill={box.hasInactive ? '#f3f3f3' : color.fill}
        stroke={box.hasInactive ? '#333' : color.stroke}
        strokeWidth={1}
        strokeDasharray={box.hasInactive ? '4 3' : undefined}
      />
      {box.lines.map((line, i) => (
        <text
          key={i}
          x={x + box.width / 2}
          y={i === 0 ? y + 20 : y + 20 + 14 + (i - 1) * 13}
          textAnchor="middle"
          fontSize={i === 0 ? 13 : 10.5}
          fontWeight={i === 0 ? 'bold' : 'normal'}
          fill={box.hasInactive ? '#999' : '#222'}
          fontFamily="sans-serif"
        >
          {line}
        </text>
      ))}
    </g>
  );
}

// Renders one flank's cells anchored at `edgeX` — for the right flank,
// edgeX is the walkway's right edge and boxes grow rightward (deeper lanes
// extend further from the aisle); for the left flank, edgeX is the
// walkway's left edge and boxes grow leftward. `direction` controls which.
function Flank({ cells, edgeX, direction, yForRow }: { cells: Cell[]; edgeX: number; direction: 1 | -1; yForRow: (r: number) => number }) {
  return (
    <>
      {cells.map((cell, r) => {
        const y = yForRow(r);
        let cursor = edgeX;
        return (
          <g key={cell.posVal}>
            {cell.boxes.map((box) => {
              const x = direction === 1 ? cursor : cursor - box.width;
              cursor = direction === 1 ? cursor + box.width : cursor - box.width;
              return <AisleCellBox key={box.key} box={box} x={x} y={y} />;
            })}
          </g>
        );
      })}
    </>
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

  const aisleWidths = aisles.map((a) => a.maxLeftW + WALKWAY_W + a.maxRightW);
  const totalWidth = PAD_X * 2 + aisleWidths.reduce((s, w) => s + w, 0) + AISLE_GAP * (aisles.length - 1);

  // Row 0 (nearest the bottom-right reference corner) always sits on the
  // bottom line, shared across every aisle — a taller aisle just extends
  // further up rather than floating independently.
  const yForRow = (rowIndex: number) => PAD_TOP + (maxRows - 1 - rowIndex) * rowBandH;

  // Legend only lists Storage Types actually present, not all five always —
  // keeps it relevant to what's actually on screen.
  const presentStorageTypes = Array.from(new Set(locations.map((l) => l.storageType))).sort();

  return (
    <div>
      <p style={{ fontSize: 12, color: '#666', marginTop: 4, marginBottom: 12 }}>
        <strong>{warehouseLabel}</strong> — {aisles.length} aisle(s), structural layout only (no occupancy).
        Aisle 1 sits closest to the bottom-right corner; each further aisle is added to its left. A single-sided
        aisle draws as one flank on the right; a second flank (left) only appears when it was actually generated (a
        Second Range, or the "mirror" checkbox) — never guessed. Rows pair by position, not by raw number.
        {skipped > 0 ? ` ${skipped} location(s) with no Aisle set are not shown.` : ''}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 10, fontSize: 12 }}>
        {presentStorageTypes.map((st) => {
          const color = STORAGE_TYPE_COLORS[st] || DEFAULT_BOX_COLOR;
          return (
            <span key={st} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 12, height: 12, borderRadius: 2, background: color.fill, border: `1.5px solid ${color.stroke}`, display: 'inline-block' }} />
              {labelFor(STORAGE_TYPE_OPTIONS, st)}
            </span>
          );
        })}
      </div>
      <div style={{ overflow: 'auto', border: '1px solid #ddd', borderRadius: 8, padding: 8 }}>
        <svg width={totalWidth} height={totalHeight} viewBox={`0 0 ${totalWidth} ${totalHeight}`}>
          {(() => {
            // Place aisles right-to-left: Aisle 1 (index 0) hugs the right
            // edge, each next aisle's right edge sits AISLE_GAP to the left
            // of the previous aisle's left edge.
            let cursorRight = totalWidth - PAD_X;
            return aisles.map((aisle) => {
              const aisleRightEdge = cursorRight;
              const walkwayRightX = aisleRightEdge - aisle.maxRightW;
              const walkwayLeftX = walkwayRightX - WALKWAY_W;
              const aisleLeftEdge = walkwayLeftX - aisle.maxLeftW;
              cursorRight = aisleLeftEdge - AISLE_GAP;

              return (
                <g key={aisle.aisleCode}>
                  <rect x={walkwayLeftX} y={PAD_TOP} width={WALKWAY_W} height={maxRows * rowBandH - ROW_GAP} fill="#a9a9a9" />
                  {aisle.section ? (
                    <>
                      <text
                        x={walkwayLeftX + WALKWAY_W / 2}
                        y={PAD_TOP - 24}
                        textAnchor="middle"
                        fontSize={13}
                        fontWeight="bold"
                        fontFamily="sans-serif"
                        fill="#222"
                      >
                        Section {aisle.section}
                      </text>
                      <text
                        x={walkwayLeftX + WALKWAY_W / 2}
                        y={PAD_TOP - 10}
                        textAnchor="middle"
                        fontSize={10}
                        fontFamily="sans-serif"
                        fill="#777"
                      >
                        Aisle {aisle.aisleCode}
                      </text>
                    </>
                  ) : (
                    <text
                      x={walkwayLeftX + WALKWAY_W / 2}
                      y={PAD_TOP - 10}
                      textAnchor="middle"
                      fontSize={12}
                      fontWeight="bold"
                      fontFamily="sans-serif"
                      fill="#222"
                    >
                      {aisle.aisleCode}
                    </text>
                  )}
                  {aisle.rightFlankNumber != null && (
                    <text
                      x={walkwayRightX + aisle.maxRightW / 2}
                      y={PAD_TOP - 10}
                      textAnchor="middle"
                      fontSize={12}
                      fontWeight="bold"
                      fontFamily="sans-serif"
                      fill="#222"
                    >
                      R{aisle.rightFlankNumber}
                    </text>
                  )}
                  {aisle.leftFlankNumber != null && (
                    <text
                      x={walkwayLeftX - aisle.maxLeftW / 2}
                      y={PAD_TOP - 10}
                      textAnchor="middle"
                      fontSize={12}
                      fontWeight="bold"
                      fontFamily="sans-serif"
                      fill="#222"
                    >
                      R{aisle.leftFlankNumber}
                    </text>
                  )}
                  <Flank cells={aisle.leftCells} edgeX={walkwayLeftX} direction={-1} yForRow={yForRow} />
                  <Flank cells={aisle.rightCells} edgeX={walkwayRightX} direction={1} yForRow={yForRow} />
                </g>
              );
            });
          })()}
        </svg>
      </div>
    </div>
  );
}

export default LocationsPlanView;

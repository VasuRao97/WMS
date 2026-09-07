import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, Edges, Grid, Html } from '@react-three/drei';
import * as THREE from 'three';
import { RACK_STORAGE_TYPES, type Location } from './LocationsPage';
import { STORAGE_TYPE_COLORS, DEFAULT_BOX_COLOR } from './LocationsPlanView';
import { type ColorMode, type Occupancy, ABC_CLASS_COLORS, NEUTRAL_COLOR, buildCategoryColorMap, occupancyColorFor } from './occupancyColors';
import { DetailPanel } from './LocationDetailPanel';
import { posOf, naturalCompare, uniqSorted } from './locationBoxUtils';

// True-3D companion to LocationsPlanView.tsx's top-down SVG (2026-09-05 — see
// [[wms-putaway-design]]/CLAUDE.md for the design conversation). Built after
// a dedicated visual-tradeoff discussion (isometric/SVG vs. a real WebGL
// camera) — the client's own explicit reason for wanting 3D at all: the 2D
// view collapses Level into text ("G+2"), a real 3D view can show levels
// genuinely stacked in space instead.
//
// Whole-warehouse overview + slicer (same-day follow-up, per the client's
// own reconsideration of the original "one aisle at a time" scope): "cant we
// just show the full warehouse first, then give slicers to select which
// part of warehouse they want to check." Every aisle renders by default as
// a plain, semi-transparent FOOTPRINT block (a simplified placeholder, not
// individual bins — rendering every real bin for a whole warehouse at once
// is a genuine WebGL performance risk, confirmed directly rather than
// assumed). Checking one or more aisles in the slicer (or clicking its
// footprint block directly) swaps it into full per-bin detail; every
// unchecked aisle stays visible as a footprint block for spatial context —
// confirmed directly, not "hide everything else," since keeping the whole-
// warehouse picture visible was the actual point of the ask.
//
// Reuses the EXACT same grouping rules LocationsPlanView.tsx's buildLayout/
// buildCell already established (flankNumber decides left/right, posOf()
// picks rack/column/stack depending on storageType — Ground's own `rack`
// field IS its column number, sharing the exact same LIFO-lane meaning
// `depth` already has with Rack, so a Ground column renders as its own row
// exactly like a Rack bay does — depth splits either into one box per real
// position) — same real, persisted fields, same "position pairs by index
// not by raw number" rule. What's different in 3D: Level becomes a genuine
// Y (vertical) position instead of collapsed text, Stillage's depth×width×
// height render as real box dimensions instead of text in one fixed-size
// box, and — new this pass —
// aisles themselves are laid out side by side along a global X axis, same
// "aisle 1 first, each next one further along" ordering 2D's own
// right-to-left placement already established (simplified here to a plain
// left-to-right pass — the exact corner-anchoring direction doesn't carry
// the same real-world meaning in a free-camera 3D scene the way it does on
// a fixed-orientation 2D page).
//
// Click-to-inspect (closing the original 2026-08-25 Plan View's own
// deferred item, landing in 3D first): clicking a box on a SELECTED
// (detailed) aisle shows its full detail in a side panel — Rack Name/code,
// Zone Type, Storage Type, Category, Level/Depth.

const LEVEL_HEIGHT = 1;
const RACK_BOX_SIZE = 1.1;
const POSITION_SPACING = 2.2;
const DEPTH_SPACING = 1.4;
const WALKWAY_HALF_WIDTH = 1.2;
// Stillage: scales its depth/width/height COUNTS (not real meters — same
// "not physically accurate" treatment 2D already gives these) into scene
// units. Ground/Floor: the fixed size of one real column×depth position's
// own box (each is genuinely one pallet position now, not an aggregate).
const GROUND_UNIT = 0.9;
// World-space gap between one aisle's footprint and the next — this is
// where two adjacent aisles' OUTER flanks sit back-to-back (their backs
// facing each other, not their accessible fronts), so it only needs to be a
// thin seam, not another walkway-sized gap; WALKWAY_HALF_WIDTH above is the
// one real gap. Was 3 (comparable to the walkway's own 2.4 total width)
// until the client caught it live: "there doesn't need to be a huge gap
// between 2 flanks, its back to back then aisle" (2026-09-06). Matches the
// same fix in LocationsPlanView.tsx's own AISLE_GAP.
const AISLE_GAP = 0.4;

type BoxSpec = { key: string; location: Location; x: number; y: number; z: number; w: number; h: number; d: number };

// Same flank-split / position-pairing / depth-splitting rules as
// LocationsPlanView.tsx's buildLayout()/buildCell() — see that file's own
// comment for the full history of why each rule exists. Re-derived here
// rather than shared as one function because the two views produce
// different shapes (2D screen-space boxes vs. 3D world-space boxes), but
// the GROUPING logic itself is identical on purpose. X is relative to this
// aisle's OWN centerline (0) — the caller shifts every box by the aisle's
// global offset afterward, so this function never needs to know where
// other aisles sit.
function buildBoxesForAisle(rows: Location[], rackBaysPerCrossAisle: number | null, groundBinsPerCrossAisle: number | null): BoxSpec[] {
  const distinctFlanks = Array.from(new Set(rows.map((l) => l.flankNumber).filter((f): f is number => f != null))).sort((a, b) => a - b);
  const [primaryFlank, secondaryFlank] = distinctFlanks;
  const primaryLocs = rows.filter((l) => l.flankNumber == null || l.flankNumber === primaryFlank);
  const secondaryLocs = secondaryFlank != null ? rows.filter((l) => l.flankNumber === secondaryFlank) : [];

  const boxes: BoxSpec[] = [];

  const place = (locs: Location[], sign: 1 | -1) => {
    const positions = uniqSorted(locs.map(posOf));
    // z accumulates rather than a flat `posIndex * POSITION_SPACING` — a
    // real, direct client correction in two rounds (2026-09-07). Round 1:
    // "why do we have aisle left after each pallet column?" — Ground
    // columns of the SAME bin now sit flush (no gap at all). Round 2, right
    // after: "we dont need aisle after every 4x4 bin also... after 10 bins
    // you give an aisle" — a real cross-aisle (walking access through a
    // long rack run or floor-storage row) only needs to appear
    // PERIODICALLY, not after every single bay/bin. `binsSinceAisle` counts
    // real bin BOUNDARIES crossed since the last cross-aisle (or the start
    // of this flank) — a Ground column staying within the SAME block never
    // counts as a boundary at all (still always flush, per round 1); moving
    // to a genuinely new bin (a new Rack bay, a new Ground block, or a
    // Stillage stack) counts as one, and only inserts the real
    // POSITION_SPACING gap once that count reaches the company's own
    // configured threshold (`rackBaysPerCrossAisle`/
    // `groundBinsPerCrossAisle`, `Company` fields, default 10, editable on
    // Company Settings) — otherwise it's flush too, same as a same-block
    // Ground column. A null threshold means "never insert one" (all
    // flush). Threshold applies to Stillage using the Rack number too — the
    // client's ask named only "racks and ground," Stillage stays a minor,
    // still-deferred type elsewhere in this file, not worth a third dial.
    let z = 0;
    let prevGroundBlock: string | undefined;
    let binsSinceAisle = 0;
    positions.forEach((posVal, posIndex) => {
      const atPos = locs.filter((r) => posOf(r) === posVal);
      const storageType = atPos[0].storageType;
      const groundBlock = storageType === 'GROUND_FLOOR' ? (atPos[0].block ?? undefined) : undefined;
      const sameGroundBlockAsPrev = storageType === 'GROUND_FLOOR' && groundBlock != null && groundBlock === prevGroundBlock;
      const flushStep = storageType === 'GROUND_FLOOR' ? GROUND_UNIT : RACK_BOX_SIZE;
      if (posIndex > 0) {
        if (sameGroundBlockAsPrev) {
          z += flushStep;
        } else {
          binsSinceAisle += 1;
          const threshold = storageType === 'GROUND_FLOOR' ? groundBinsPerCrossAisle : rackBaysPerCrossAisle;
          if (threshold != null && binsSinceAisle >= threshold) {
            z += POSITION_SPACING;
            binsSinceAisle = 0;
          } else {
            z += flushStep;
          }
        }
      }
      prevGroundBlock = groundBlock;

      if (RACK_STORAGE_TYPES.includes(storageType)) {
        const depthKey = (r: Location) => (r.depth != null ? String(r.depth) : '1');
        const depths = uniqSorted(atPos.map(depthKey));
        depths.forEach((d, depthIndex) => {
          const atDepth = atPos.filter((r) => depthKey(r) === d);
          const x = sign * (WALKWAY_HALF_WIDTH + RACK_BOX_SIZE / 2 + depthIndex * DEPTH_SPACING);
          atDepth.forEach((row) => {
            const levelNum = Number(row.level) || 1;
            const y = (levelNum - 1) * LEVEL_HEIGHT + (LEVEL_HEIGHT * 0.85) / 2;
            boxes.push({ key: row.id, location: row, x, y, z, w: RACK_BOX_SIZE, h: LEVEL_HEIGHT * 0.85, d: RACK_BOX_SIZE });
          });
        });
      } else if (storageType === 'GROUND_FLOOR') {
        // `atPos` is one COLUMN's own depth-series now (posOf() groups by
        // block+column, see locationBoxUtils.ts) — structurally identical to
        // one Rack bay's depth-series, so this mirrors the RACK branch
        // above almost exactly: fixed floor-level Y (no `level` concept for
        // Ground) instead of level-driven Y, GROUND_UNIT-sized boxes instead
        // of RACK_BOX_SIZE, otherwise the same depth-splits-along-x
        // treatment. A real client correction landed this shape (2026-09-06,
        // same day as an earlier attempt that manually spread columns+
        // depths inside one whole-BLOCK atPos — "how is this 4x4? looks
        // like 1x4... dont keep your rack as ideal, we need to align
        // separately"): unifying Ground's column with Rack's own per-bay row
        // grouping (both already reuse the exact same `rack`/`depth`
        // fields, see schema.prisma) is what actually produces a real grid
        // across many rows, not a forced Rack-ism.
        // depthTier (2026-09-07 — "when we say 4 deep, there should be 1
        // more 4 deep behind the first bin then the aisle") — a real bin
        // can now be followed by MORE bins stacked back-to-back going
        // further from the aisle, each restarting its own depth at 1. The
        // key combines tier+depth (zero-padded, tier-major) so every real
        // position still lands at its own, correctly-ordered X offset —
        // depth 1 of tier 2 is a different real position from depth 1 of
        // tier 1, plain depth alone would collide them at the same offset.
        const depthKey = (r: Location) => `${String(r.depthTier ?? 1).padStart(4, '0')}~${String(r.depth ?? 1).padStart(4, '0')}`;
        const depths = uniqSorted(atPos.map(depthKey));
        depths.forEach((dKey, depthIndex) => {
          const atDepth = atPos.filter((r) => depthKey(r) === dKey);
          const x = sign * (WALKWAY_HALF_WIDTH + GROUND_UNIT / 2 + depthIndex * GROUND_UNIT);
          const y = GROUND_UNIT / 2;
          atDepth.forEach((row) => {
            boxes.push({ key: row.id, location: row, x, y, z, w: GROUND_UNIT, h: GROUND_UNIT, d: GROUND_UNIT });
          });
        });
      } else {
        // Stillage — one row per stack, one box per row, sized by its own
        // depth×width×height counts (same "text, not sub-boxes" universe 2D
        // stays in for this type — here it's real dimensions instead of
        // text, but still one box per row, no further splitting). Ground/
        // Floor used to share this exact branch too, before its 2026-09-06
        // rewrite split it out above.
        atPos.forEach((row) => {
          const w = (row.width ?? 1) * GROUND_UNIT;
          const h = (row.height ?? 1) * GROUND_UNIT;
          const d = (row.depth ?? 1) * GROUND_UNIT;
          const x = sign * (WALKWAY_HALF_WIDTH + w / 2);
          const y = h / 2;
          boxes.push({ key: row.id, location: row, x, y, z, w, h, d });
        });
      }
    });
  };

  place(primaryLocs, 1);
  place(secondaryLocs, -1);
  return boxes;
}

type Footprint = { x: number; y: number; z: number; w: number; h: number; d: number };
type AisleLayout = { aisleCode: string; boxes: BoxSpec[]; footprint: Footprint; storageTypes: string[] };

// Groups every location by Aisle, computes each aisle's own box layout
// independently (relative to its own centerline), then places aisles side
// by side along a global X axis — Aisle 1 (lowest code) first, each next
// aisle's footprint starting where the previous one's ends plus AISLE_GAP.
// A location with no Aisle set is skipped entirely, same as 2D.
function buildWarehouseLayout(locations: Location[], rackBaysPerCrossAisle: number | null, groundBinsPerCrossAisle: number | null): AisleLayout[] {
  const withAisle = locations.filter((l) => l.aisle);
  const byAisle = new Map<string, Location[]>();
  for (const l of withAisle) {
    const key = l.aisle!;
    if (!byAisle.has(key)) byAisle.set(key, []);
    byAisle.get(key)!.push(l);
  }
  const aisleCodes = Array.from(byAisle.keys()).sort(naturalCompare);

  const layouts: AisleLayout[] = [];
  let cursorX = 0;
  for (const aisleCode of aisleCodes) {
    const rows = byAisle.get(aisleCode)!;
    const localBoxes = buildBoxesForAisle(rows, rackBaysPerCrossAisle, groundBinsPerCrossAisle);
    if (localBoxes.length === 0) continue;

    const minX = Math.min(...localBoxes.map((b) => b.x - b.w / 2));
    const maxX = Math.max(...localBoxes.map((b) => b.x + b.w / 2));
    const maxZ = Math.max(...localBoxes.map((b) => b.z + b.d / 2));
    const maxY = Math.max(...localBoxes.map((b) => b.y + b.h / 2));
    const width = maxX - minX;

    const offsetX = cursorX - minX;
    const shiftedBoxes = localBoxes.map((b) => ({ ...b, x: b.x + offsetX }));

    const footprint: Footprint = {
      x: offsetX + (minX + maxX) / 2,
      y: maxY / 2,
      z: maxZ / 2,
      w: width,
      h: Math.max(maxY, 0.4),
      d: maxZ,
    };
    const storageTypes = Array.from(new Set(rows.map((r) => r.storageType)));

    layouts.push({ aisleCode, boxes: shiftedBoxes, footprint, storageTypes });
    cursorX += width + AISLE_GAP;
  }
  return layouts;
}

function LocationBox({ box, isSelected, onSelect, color }: { box: BoxSpec; isSelected: boolean; onSelect: (l: Location) => void; color: { fill: string; stroke: string } }) {
  const inactive = !box.location.isActive;

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onSelect(box.location);
  };

  return (
    <mesh position={[box.x, box.y, box.z]} onClick={handleClick}>
      <boxGeometry args={[box.w, box.h, box.d]} />
      <meshStandardMaterial color={inactive ? '#cccccc' : color.fill} transparent opacity={inactive ? 0.5 : 1} />
      <Edges color={isSelected ? '#f59e0b' : inactive ? '#666666' : color.stroke} linewidth={isSelected ? 2 : 1} />
    </mesh>
  );
}

type BinOutlineSpec = { key: string; x: number; y: number; z: number; w: number; h: number; d: number };

// Groups every Ground/Floor box in one aisle's render back into its real
// BIN (block + depthTier) — now that columns render flush against each
// other with no gap between them (2026-09-06/07 fixes), one bin's own
// boundary is no longer visually obvious on its own, since it isn't set
// apart from its neighbor bins until a periodic cross-aisle happens to
// land there. A real client ask (2026-09-07): "in ground storage, just
// highlight each bin (just give a border)." Grouped by `(flankNumber,
// block, depthTier)`, not `block` alone — a mirrored layout can genuinely
// reuse the same block number on both flanks (two physically distinct
// bins, not one), and a bin can now be followed by MORE bins stacked
// back-to-back in the depth direction (`Location.depthTier`, same day,
// same client conversation — "there should be 1 more 4 deep behind the
// first bin") — each tier is its own separate bin, needing its own
// separate outline too, not one outline spanning the whole stack.
// Rack/Stillage are untouched — the ask was Ground-specific, and a Rack
// bay already reads as its own distinct unit (one box per depth position,
// no multi-column grouping to make legible the way a Ground bin needs).
function computeGroundBinOutlines(boxes: BoxSpec[]): BinOutlineSpec[] {
  const groups = new Map<string, BoxSpec[]>();
  for (const box of boxes) {
    if (box.location.storageType !== 'GROUND_FLOOR' || box.location.block == null) continue;
    const key = `${box.location.flankNumber ?? 'x'}~${box.location.block}~${box.location.depthTier ?? 1}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(box);
  }
  return Array.from(groups.entries()).map(([key, group]) => {
    const minX = Math.min(...group.map((b) => b.x - b.w / 2));
    const maxX = Math.max(...group.map((b) => b.x + b.w / 2));
    const minY = Math.min(...group.map((b) => b.y - b.h / 2));
    const maxY = Math.max(...group.map((b) => b.y + b.h / 2));
    const minZ = Math.min(...group.map((b) => b.z - b.d / 2));
    const maxZ = Math.max(...group.map((b) => b.z + b.d / 2));
    return { key, x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2, w: maxX - minX, h: maxY - minY, d: maxZ - minZ };
  });
}

// A darker shade of Ground/Floor's own orange stroke (not an unrelated
// color) — bold enough to read as a distinct GROUPING border, one level up
// from each individual position's own thin cell edge, while still visually
// belonging to the same storage-type family. `raycast={() => null}`
// (a standard R3F "click-through" override) keeps this purely decorative —
// without it, this outline box would compete with the real per-position
// boxes underneath for click-to-inspect, since it deliberately shares
// almost the same volume as the bin's own boxes combined.
function GroundBinOutline({ outline }: { outline: BinOutlineSpec }) {
  return (
    <mesh position={[outline.x, outline.y, outline.z]} raycast={() => null}>
      <boxGeometry args={[outline.w, outline.h, outline.d]} />
      <meshBasicMaterial visible={false} />
      <Edges color="#9a3412" linewidth={2} />
    </mesh>
  );
}

// The simplified stand-in for an unselected aisle — one translucent box
// spanning its whole real footprint (not individual bins), labeled with its
// Aisle code via drei's <Html> (cheap here — at most a handful of these
// exist per warehouse, unlike the hundreds of real bins it stands in for).
// Clicking it is a second way to select the same aisle the checkbox slicer
// does — either path leads to the same full-detail render.
function AisleFootprint({ layout, onSelect }: { layout: AisleLayout; onSelect: (aisleCode: string) => void }) {
  const color = STORAGE_TYPE_COLORS[layout.storageTypes[0]] || DEFAULT_BOX_COLOR;
  const { footprint } = layout;
  return (
    <mesh position={[footprint.x, footprint.y, footprint.z]} onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onSelect(layout.aisleCode); }}>
      <boxGeometry args={[footprint.w, footprint.h, footprint.d]} />
      <meshStandardMaterial color={color.fill} transparent opacity={0.35} />
      <Edges color={color.stroke} />
      <Html center position={[0, footprint.h / 2 + 0.4, 0]} style={{ pointerEvents: 'none', fontSize: 12, fontFamily: 'sans-serif', background: '#fff', padding: '2px 6px', borderRadius: 4, border: '1px solid #ccc', whiteSpace: 'nowrap' }}>
        Aisle {layout.aisleCode}
      </Html>
    </mesh>
  );
}

// The Aisle-code label an unselected aisle gets for free from
// `AisleFootprint` above — once an aisle is checked into full per-bin
// detail, that footprint mesh (and its Html label) stops rendering
// entirely, so the aisle's own identity disappeared from the scene with
// nothing replacing it (2026-09-07 — "can we name the row, aisle? i dont
// see any numbering," caught looking at a drilled-in aisle in 3D). This
// renders the identical "Aisle {code}" label, positioned the same way
// (just above the tallest box in the aisle, using the same `footprint`
// bounding box every layout already carries) but with no mesh/click
// handler around it — the detail view's own boxes already handle clicks.
function AisleDetailLabel({ layout }: { layout: AisleLayout }) {
  const { footprint } = layout;
  return (
    <Html center position={[footprint.x, footprint.y + footprint.h / 2 + 0.4, footprint.z]} style={{ pointerEvents: 'none', fontSize: 12, fontFamily: 'sans-serif', background: '#fff', padding: '2px 6px', borderRadius: 4, border: '1px solid #ccc', whiteSpace: 'nowrap' }}>
      Aisle {layout.aisleCode}
    </Html>
  );
}

// Camera auto-focus (2026-09-05 "upgrade mode" backlog, item 4) — checking
// an aisle into detail used to leave the camera exactly where it was (a
// fixed whole-warehouse overview computed once on mount), so finding what
// you just selected meant manually orbiting/zooming over to it yourself.
// This computes a real camera position + OrbitControls target that FITS
// whichever aisles are currently selected — confirmed directly rather than
// picking "most recently checked": with several aisles checked at once,
// the camera frames all of them together, not just the last one. With
// NONE selected (including on first mount), "fit" naturally degrades to
// fitting every aisle — the same whole-warehouse view as before, so the
// initial load and the "uncheck everything" case both land on the exact
// same framing without needing a special case for either.
function computeFocus(aislesToFit: AisleLayout[]): { camPos: [number, number, number]; target: [number, number, number] } {
  const minX = Math.min(...aislesToFit.map((l) => l.footprint.x - l.footprint.w / 2));
  const maxX = Math.max(...aislesToFit.map((l) => l.footprint.x + l.footprint.w / 2));
  const maxZ = Math.max(...aislesToFit.map((l) => l.footprint.z + l.footprint.d / 2));
  // Top edge of the tallest footprint being fit — factored into both the
  // camera's height and the pull-back distance (2026-09-06, caught live
  // once the Simulation's own Levels became configurable: a 5-level layout
  // could start the camera below/inside the stack, since this used to size
  // the view purely off the X/Z footprint and never looked at how TALL
  // anything actually was). Degrades to the original framing for a typical
  // short (2-3 level) layout — `maxY` stays small enough there that it
  // never becomes the binding term in either `Math.max`.
  const maxY = Math.max(...aislesToFit.map((l) => l.footprint.y + l.footprint.h / 2));
  const centerX = (minX + maxX) / 2;
  const span = Math.max(maxX - minX, maxZ, maxY, 4); // a floor so a single small aisle doesn't zoom in absurdly close
  return {
    camPos: [centerX, Math.max(6, span / 2.5, maxY + 4), maxZ + span * 0.6 + 4],
    target: [centerX, maxY / 2, maxZ / 2],
  };
}

// Smoothly (not a snap-instant jump, confirmed directly) nudges the real
// three.js camera + OrbitControls target toward whatever computeFocus()
// last returned, every frame, until close enough — then stops, so it never
// fights a user who manually orbits/pans afterward. Lives inside <Canvas>
// (useFrame only works there) as its own component purely for that reason;
// it renders nothing.
function CameraRig({
  camPos,
  target,
  controlsRef,
  resetSignal,
}: {
  camPos: [number, number, number];
  target: [number, number, number];
  controlsRef: React.RefObject<any>;
  // Bumped by the "Reset View" button — see its own comment at the call
  // site for why this needs to be a separate trigger from the camPos/target
  // key check just below, not folded into it.
  resetSignal: number;
}) {
  // `focusRef` is written fresh on every render (a plain assignment, not an
  // effect) so `useFrame`'s callback — registered once, called every frame
  // by R3F's own render loop, independent of React's render cycle — always
  // reads the CURRENT `camPos`/`target` instead of whatever closure it
  // happened to capture at registration time. A real bug caught during
  // build, not a defensive habit: an earlier `useEffect([camPos[0], ...])`
  // version compiled clean and looked correct, but the camera never
  // actually moved on selection change — direct instrumentation showed the
  // computed focus itself updated correctly every render, yet `useFrame`
  // kept animating toward the ORIGINAL mount-time target forever. This ref
  // pattern sidesteps the whole question of whether useFrame re-captures
  // its closure by never relying on the closure for the values at all.
  const focusRef = useRef({ camPos, target });
  focusRef.current = { camPos, target };
  const animating = useRef(true);
  const prevKey = useRef('');
  const prevReset = useRef(resetSignal);
  const key = `${camPos.join(',')}|${target.join(',')}`;
  if (key !== prevKey.current || resetSignal !== prevReset.current) {
    prevKey.current = key;
    prevReset.current = resetSignal;
    animating.current = true;
  }

  // Real root cause of "I cannot see anything in it" (2026-09-06, caught by
  // the client's own live testing): `<Canvas camera={{ position: camPos }}>`
  // already places the camera correctly on mount, but `OrbitControls` itself
  // has no `target` prop (deliberately — CameraRig owns it imperatively, see
  // below), so `controls.target` starts at three.js's own default (0,0,0)
  // instead of the real initial focus target. The camera sat in the RIGHT
  // place but was aimed at the ORIGIN — for a small default layout the
  // resulting angle was off enough to look empty, and it only "fixed
  // itself" once the slow per-frame lerp (0.08) crawled `controls.target`
  // from (0,0,0) to the real target over a couple of seconds, which reads
  // as a blank canvas the whole time it's converging. This effect runs
  // ONCE on mount and snaps `controls.target` straight to the correct
  // initial value with no animation — the very first frame is already
  // correct. Every LATER focus change (checking a different aisle) still
  // animates smoothly via the useFrame lerp below, untouched.
  useEffect(() => {
    const controls = controlsRef.current;
    if (controls) {
      controls.target.set(target[0], target[1], target[2]);
      controls.update();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFrame(({ camera }) => {
    if (!animating.current) return;
    const { camPos: cp, target: tg } = focusRef.current;
    camera.position.set(
      THREE.MathUtils.lerp(camera.position.x, cp[0], 0.08),
      THREE.MathUtils.lerp(camera.position.y, cp[1], 0.08),
      THREE.MathUtils.lerp(camera.position.z, cp[2], 0.08),
    );
    const controls = controlsRef.current;
    if (controls) {
      controls.target.set(
        THREE.MathUtils.lerp(controls.target.x, tg[0], 0.08),
        THREE.MathUtils.lerp(controls.target.y, tg[1], 0.08),
        THREE.MathUtils.lerp(controls.target.z, tg[2], 0.08),
      );
      controls.update();
    }
    const dx = camera.position.x - cp[0];
    const dy = camera.position.y - cp[1];
    const dz = camera.position.z - cp[2];
    if (dx * dx + dy * dy + dz * dz < 0.01) animating.current = false;
  });
  return null;
}

function Locations3DView({
  locations,
  colorMode,
  occupancy,
  rackBaysPerCrossAisle = 10,
  groundBinsPerCrossAisle = 10,
}: {
  locations: Location[];
  colorMode: ColorMode;
  occupancy: Occupancy[];
  // Company-configured 3D cross-aisle spacing (2026-09-07) — optional so
  // callers that don't fetch Company Settings (or haven't loaded them yet)
  // still get a sensible default, matching the schema's own DB default.
  rackBaysPerCrossAisle?: number | null;
  groundBinsPerCrossAisle?: number | null;
}) {
  const [selected, setSelected] = useState<Location | null>(null);
  const [selectedAisles, setSelectedAisles] = useState<Set<string>>(new Set());
  // Called unconditionally, alongside the other hooks above — the empty-
  // state early return below must never skip a hook call between renders.
  const controlsRef = useRef<any>(null);
  // "Reset View" (2026-09-07 — "whats with this camera, not very user
  // friendly"): a plain incrementing nonce, not a boolean, since clicking
  // Reset twice in a row with nothing else changing in between still needs
  // to register as a fresh request each time. CameraRig's own re-animate
  // check already keys off whether `camPos`/`target` CHANGED — which they
  // won't here, since checked aisles aren't changing, only the user's own
  // manual orbit/zoom/pan drifted away from that same framing — so this
  // nonce is threaded through as a second, independent trigger alongside
  // that key check.
  const [resetSignal, setResetSignal] = useState(0);

  const layouts = useMemo(
    () => buildWarehouseLayout(locations, rackBaysPerCrossAisle ?? null, groundBinsPerCrossAisle ?? null),
    [locations, rackBaysPerCrossAisle, groundBinsPerCrossAisle],
  );

  if (layouts.length === 0) {
    return <p style={{ marginTop: 16, color: '#666' }}>No locations with an Aisle set in this warehouse — nothing to render in 3D.</p>;
  }

  const toggleAisle = (aisleCode: string) => {
    setSelectedAisles((prev) => {
      const next = new Set(prev);
      if (next.has(aisleCode)) next.delete(aisleCode);
      else next.add(aisleCode);
      return next;
    });
  };

  // Occupancy overlay (2026-09-05) — only applies to a SELECTED aisle's real
  // per-bin boxes. An unselected aisle's footprint block stays colored by
  // storageType regardless of mode — it's a simplified stand-in for many
  // bins with potentially many different occupants, there's no single
  // category/class it could honestly represent, so it deliberately doesn't
  // try; the real occupancy detail only shows once you drill into it.
  const occupancyByLocationId = new Map(occupancy.map((o) => [o.locationId, o]));
  const categoryColors = buildCategoryColorMap(occupancy);
  const getColor = (location: Location): { fill: string; stroke: string } => {
    const overlay = occupancyColorFor(colorMode, occupancyByLocationId.get(location.id), categoryColors);
    return overlay ?? STORAGE_TYPE_COLORS[location.storageType] ?? DEFAULT_BOX_COLOR;
  };

  // totalWidth/totalDepth size the floor/grid to the WHOLE warehouse always
  // — only the camera refocuses on a selection, the ground plane itself
  // shouldn't shrink or disappear just because fewer aisles are detailed.
  const totalWidth = Math.max(...layouts.map((l) => l.footprint.x + l.footprint.w / 2));
  const totalDepth = Math.max(...layouts.map((l) => l.footprint.d));

  const aislesToFit = selectedAisles.size > 0 ? layouts.filter((l) => selectedAisles.has(l.aisleCode)) : layouts;
  const focus = computeFocus(aislesToFit);

  return (
    <div>
      {colorMode !== 'structural' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 8, fontSize: 12 }}>
          <span style={{ color: '#888' }}>
            {colorMode === 'category' ? 'Colored by occupant Category (selected aisles only):' : "Colored by occupant A/B/C Class (selected aisles only):"}
          </span>
          {colorMode === 'class' &&
            (['A', 'B', 'C'] as const).map((cls) => (
              <span key={cls} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 12, height: 12, borderRadius: 2, background: ABC_CLASS_COLORS[cls].fill, border: `1.5px solid ${ABC_CLASS_COLORS[cls].stroke}`, display: 'inline-block' }} />
                Class {cls}
              </span>
            ))}
          {colorMode === 'category' &&
            [...new Map(occupancy.filter((o) => o.categoryId).map((o) => [o.categoryId, o.categoryName])).entries()]
              .sort((a, b) => (a[1] || '').localeCompare(b[1] || ''))
              .map(([categoryId, categoryName]) => {
                const color = categoryColors.get(categoryId!)!;
                return (
                  <span key={categoryId} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 12, height: 12, borderRadius: 2, background: color.fill, border: `1.5px solid ${color.stroke}`, display: 'inline-block' }} />
                    {categoryName}
                  </span>
                );
              })}
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 12, height: 12, borderRadius: 2, background: NEUTRAL_COLOR.fill, border: `1.5px solid ${NEUTRAL_COLOR.stroke}`, display: 'inline-block' }} />
            Empty
          </span>
        </div>
      )}
      {/* The slicer — plain checkboxes, same "no component library" style as
          every other control in this app. Multiple aisles can be checked at
          once; each one independently swaps between its footprint block and
          full per-bin detail. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 8, fontSize: 13 }}>
        <strong style={{ alignSelf: 'center' }}>Show in detail:</strong>
        {layouts.map((l) => (
          <label key={l.aisleCode} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={selectedAisles.has(l.aisleCode)} onChange={() => toggleAisle(l.aisleCode)} />
            Aisle {l.aisleCode}
          </label>
        ))}
      </div>

      <div style={{ position: 'relative', border: '1px solid #ddd', borderRadius: 8, height: 520 }}>
        <button
          type="button"
          onClick={() => setResetSignal((n) => n + 1)}
          style={{ position: 'absolute', top: 12, left: 12, zIndex: 1, padding: '5px 10px', fontSize: 12, background: '#fff', border: '1px solid #ccc', borderRadius: 4, cursor: 'pointer' }}
        >
          Reset View
        </button>
        <Canvas camera={{ position: focus.camPos, fov: 50 }} onPointerMissed={() => setSelected(null)}>
          <CameraRig camPos={focus.camPos} target={focus.target} controlsRef={controlsRef} resetSignal={resetSignal} />
          <ambientLight intensity={0.7} />
          <directionalLight position={[10, 15, 10]} intensity={0.8} />
          {/* Solid floor beneath the grid lines — without this the "ground"
              was just the page's own white background showing through,
              which read as empty space rather than an actual warehouse
              floor. Sits a hair below y=0 to avoid z-fighting with the grid
              lines drawn on top. */}
          <mesh position={[totalWidth / 2, -0.02, totalDepth / 2]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
            <planeGeometry args={[Math.max(totalWidth, totalDepth) + 20, Math.max(totalWidth, totalDepth) + 20]} />
            <meshStandardMaterial color="#c9c7bd" />
          </mesh>
          <Grid args={[Math.max(totalWidth, totalDepth) + 20, Math.max(totalWidth, totalDepth) + 20]} position={[totalWidth / 2, 0, totalDepth / 2]} rotation={[Math.PI / 2, 0, 0]} cellColor="#b0aea3" sectionColor="#8c8a80" fadeDistance={60} />
          {layouts.map((layout) =>
            selectedAisles.has(layout.aisleCode) ? (
              <group key={layout.aisleCode}>
                <AisleDetailLabel layout={layout} />
                {layout.boxes.map((box) => (
                  <LocationBox key={box.key} box={box} isSelected={selected?.id === box.location.id} onSelect={setSelected} color={getColor(box.location)} />
                ))}
                {computeGroundBinOutlines(layout.boxes).map((outline) => (
                  <GroundBinOutline key={outline.key} outline={outline} />
                ))}
              </group>
            ) : (
              <AisleFootprint key={layout.aisleCode} layout={layout} onSelect={toggleAisle} />
            ),
          )}
          {/* No `target` prop here — CameraRig above owns the target
              imperatively (smoothly nudging it every frame), a static prop
              here would fight that. Damping (2026-09-07 — "whats with this
              camera, not very user friendly") only smooths USER-driven
              orbit/zoom/pan (an inertial glide instead of stopping dead the
              instant the mouse is released) — it doesn't touch CameraRig's
              own direct `target`/camera-position writes above, which apply
              immediately either way, so the two systems don't fight each
              other. drei's OrbitControls already calls `.update()` every
              frame regardless, which damping needs to actually animate. */}
          <OrbitControls ref={controlsRef} makeDefault enableDamping dampingFactor={0.12} />
        </Canvas>
        <p style={{ position: 'absolute', bottom: 8, left: 12, fontSize: 11, color: '#888', margin: 0 }}>
          Drag to orbit, scroll to zoom, right-drag to pan. Click an aisle block (or check it above) to see its bins; click a bin for details.
        </p>
        {selected && <DetailPanel location={selected} occupancy={occupancyByLocationId.get(selected.id)} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}

export default Locations3DView;

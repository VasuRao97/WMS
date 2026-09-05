import { useMemo, useState } from 'react';
import { Canvas, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, Edges, Grid, Html } from '@react-three/drei';
import { RACK_STORAGE_TYPES, STORAGE_TYPE_OPTIONS, ZONE_TYPE_OPTIONS, labelFor, type Location } from './LocationsPage';
import { STORAGE_TYPE_COLORS, DEFAULT_BOX_COLOR } from './LocationsPlanView';

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
// picks rack/block/stack depending on storageType, depth splits a Rack
// position into one box per real position) — same real, persisted fields,
// same "position pairs by index not by raw number" rule. What's different
// in 3D: Level becomes a genuine Y (vertical) position instead of collapsed
// text, Ground/Floor and Stillage's depth×width×height render as real box
// dimensions instead of text in one fixed-size box, and — new this pass —
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
const GROUND_UNIT = 0.9; // scales Ground/Stillage's depth/width/height COUNTS (not real meters — same "not physically accurate" treatment 2D already gives these) into scene units
const AISLE_GAP = 3; // world-space gap between one aisle's footprint and the next

function posOf(l: Location): string | undefined {
  if (l.storageType === 'GROUND_FLOOR') return l.block;
  if (l.storageType === 'STILLAGE') return l.stack;
  return l.rack;
}

function naturalCompare(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (a.trim() !== '' && b.trim() !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a.localeCompare(b);
}
function uniqSorted(values: (string | undefined)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v))).sort(naturalCompare);
}

function buildRackName(l: Location, depthCount: number): string {
  const parts = [l.flankNumber != null ? `R${l.flankNumber}` : 'R?', posOf(l) ?? '?'];
  if (depthCount > 1 && l.depth != null) parts.push(`D${l.depth}`);
  return parts.join('-');
}

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
function buildBoxesForAisle(rows: Location[]): BoxSpec[] {
  const distinctFlanks = Array.from(new Set(rows.map((l) => l.flankNumber).filter((f): f is number => f != null))).sort((a, b) => a - b);
  const [primaryFlank, secondaryFlank] = distinctFlanks;
  const primaryLocs = rows.filter((l) => l.flankNumber == null || l.flankNumber === primaryFlank);
  const secondaryLocs = secondaryFlank != null ? rows.filter((l) => l.flankNumber === secondaryFlank) : [];

  const boxes: BoxSpec[] = [];

  const place = (locs: Location[], sign: 1 | -1) => {
    const positions = uniqSorted(locs.map(posOf));
    positions.forEach((posVal, posIndex) => {
      const z = posIndex * POSITION_SPACING;
      const atPos = locs.filter((r) => posOf(r) === posVal);
      const storageType = atPos[0].storageType;

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
      } else {
        // Ground/Floor or Stillage — one box per row, sized by its own
        // depth×width×height counts (same "text, not sub-boxes" universe
        // 2D stays in for these two types — here it's real dimensions
        // instead of text, but still one box per row, no further splitting).
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
function buildWarehouseLayout(locations: Location[]): AisleLayout[] {
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
    const localBoxes = buildBoxesForAisle(rows);
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

function LocationBox({ box, isSelected, onSelect }: { box: BoxSpec; isSelected: boolean; onSelect: (l: Location) => void }) {
  const color = STORAGE_TYPE_COLORS[box.location.storageType] || DEFAULT_BOX_COLOR;
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

function DetailPanel({ location, onClose }: { location: Location; onClose: () => void }) {
  // Always shows the -D{n} suffix when a depth value exists at all, rather
  // than re-deriving whether this position genuinely has more than one
  // depth (2D's own rule) — the "Depth position" field below already gives
  // the precise number either way, this header is just a convenience label.
  const rackName = RACK_STORAGE_TYPES.includes(location.storageType) ? buildRackName(location, location.depth != null ? 2 : 1) : location.code;
  return (
    <div style={{ position: 'absolute', top: 12, right: 12, width: 240, background: '#fff', border: '1px solid #ccc', borderRadius: 8, padding: 12, fontSize: 13, boxShadow: '0 2px 8px rgba(0,0,0,0.12)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong>{rackName}</strong>
        <button type="button" onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 14 }}>✕</button>
      </div>
      <p style={{ margin: '4px 0' }}><strong>Code:</strong> {location.code}</p>
      <p style={{ margin: '4px 0' }}><strong>Zone Type:</strong> {labelFor(ZONE_TYPE_OPTIONS, location.zoneType)}</p>
      <p style={{ margin: '4px 0' }}><strong>Storage Type:</strong> {labelFor(STORAGE_TYPE_OPTIONS, location.storageType)}</p>
      <p style={{ margin: '4px 0' }}><strong>Category:</strong> {location.category?.name || '—'}</p>
      {RACK_STORAGE_TYPES.includes(location.storageType) ? (
        <>
          <p style={{ margin: '4px 0' }}><strong>Level:</strong> {location.level ?? '—'}</p>
          <p style={{ margin: '4px 0' }}><strong>Depth position:</strong> {location.depth ?? 1}</p>
        </>
      ) : (
        <p style={{ margin: '4px 0' }}><strong>Dimensions (D×W×H):</strong> {location.depth ?? 1}×{location.width ?? 1}×{location.height ?? 1}</p>
      )}
      <p style={{ margin: '4px 0' }}><strong>Status:</strong> {location.isActive ? 'Active' : 'Inactive'}</p>
    </div>
  );
}

function Locations3DView({ locations }: { locations: Location[] }) {
  const [selected, setSelected] = useState<Location | null>(null);
  const [selectedAisles, setSelectedAisles] = useState<Set<string>>(new Set());

  const layouts = useMemo(() => buildWarehouseLayout(locations), [locations]);

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

  const totalWidth = Math.max(...layouts.map((l) => l.footprint.x + l.footprint.w / 2));
  const totalDepth = Math.max(...layouts.map((l) => l.footprint.d));

  return (
    <div>
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
        <Canvas camera={{ position: [totalWidth / 2, Math.max(6, totalWidth / 3), totalDepth + 10], fov: 50 }} onPointerMissed={() => setSelected(null)}>
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
            selectedAisles.has(layout.aisleCode)
              ? layout.boxes.map((box) => (
                  <LocationBox key={box.key} box={box} isSelected={selected?.id === box.location.id} onSelect={setSelected} />
                ))
              : <AisleFootprint key={layout.aisleCode} layout={layout} onSelect={toggleAisle} />,
          )}
          <OrbitControls target={[totalWidth / 2, 1, totalDepth / 2]} makeDefault />
        </Canvas>
        <p style={{ position: 'absolute', bottom: 8, left: 12, fontSize: 11, color: '#888', margin: 0 }}>
          Drag to orbit, scroll to zoom, right-drag to pan. Click an aisle block (or check it above) to see its bins; click a bin for details.
        </p>
        {selected && <DetailPanel location={selected} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}

export default Locations3DView;

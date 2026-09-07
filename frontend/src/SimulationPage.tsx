import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import LocationsPlanView from './LocationsPlanView';
import type { Location } from './LocationsPage';
import type { ColorMode, Occupancy } from './occupancyColors';

// 2026-09-06 hardening-pass fix: same reasoning as LocationsPage's own
// identical change — Locations3DView pulls in the whole three/@react-
// three/fiber/@react-three/drei stack, only needed once a viewer toggles
// to 3D mode below. Lazy-loading it here too (not just in LocationsPage)
// lets Vite split it into one shared chunk both pages defer equally,
// rather than only one of the two real consumers actually deferring it.
const Locations3DView = lazy(() => import('./Locations3DView'));

// Putaway simulation (2026-09-06 — see [[wms-putaway-design]] in memory) —
// "can we have a simulation for me to check our visuals? which uses our
// algo/logic to fill in racks... we will get to know how and whats
// happening." Runs a real batch through the backend's actual
// PutawayTasksService.suggestBin() (never a reimplementation) against a
// dedicated sandbox warehouse, then replays the returned step list here at
// an adjustable speed — the ANIMATION is purely a client-side reveal of an
// already-fully-computed real result, not a live step-by-step network
// exchange, so speed changes and pause/resume are instant with no backend
// round-trips. Reuses LocationsPlanView/Locations3DView completely
// unchanged — occupancy is built from however many steps have been
// "revealed" so far, feeding the exact same Occupancy[] shape the real
// occupancy overlay already consumes, same convention as everywhere else
// ("one component, many callers").

type SimStep = {
  stepIndex: number;
  skuId: string;
  skuCode: string;
  abcClass: string;
  categoryId: string;
  categoryName: string;
  quantity: number;
  locationId: string | null;
  locationCode: string | null;
  rackName: string | null;
  needsBin: boolean;
};

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('token')}` };
}
function jsonHeaders() {
  return { 'Content-Type': 'application/json', ...authHeaders() };
}
function errorText(data: any, fallback: string) {
  return Array.isArray(data?.message) ? data.message.join(' | ') : data?.message || fallback;
}

const BASE_DELAY_MS = 700; // 1x playback — a full step (suggestBin decision + placement) every 700ms

function SimulationPage() {
  const [sandbox, setSandbox] = useState<{ id: string; code: string; name: string } | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [unitCount, setUnitCount] = useState('20');
  // Sandbox layout config (2026-09-06 — "add option to tell which level and
  // depth" / "which kind of storage", then a same-day follow-up: "add
  // feature of length also, just 3 is too less") — Aisles alone stays
  // fixed; Storage Type is restricted to the storage types Putaway's
  // suggestBin() actually has real logic for (SPR/Drive-in/ASRS/Ground-
  // Floor — Stillage would still always come back "needs bin" today).
  // Sent along with every Run — the backend only rebuilds the sandbox's
  // layout if this doesn't already match what's there, so running again
  // with the same settings never wipes anything. "Length" is the UI label
  // for what the backend calls `racks` — how many rack positions run down
  // one flank of an aisle for SPR/Drive-in/ASRS, but for Ground/Floor
  // (added 2026-09-06, see [[wms-putaway-design]]) the SAME field means how
  // many physical BINS run down one flank instead — reused rather than
  // adding a second field, same "meaning depends on storage type"
  // convention this codebase already uses everywhere (Location.rack/depth/
  // width themselves). "Levels" is relabeled "Width" for Ground/Floor,
  // since the backend reuses that same field as "columns per bin" there
  // (Ground never stacks vertically, so "Levels" itself is meaningless for
  // it) — see isGround below.
  const [storageType, setStorageType] = useState('SPR');
  const [levels, setLevels] = useState('3');
  const [depth, setDepth] = useState('1');
  const [racks, setRacks] = useState('3');
  // Ground/Floor only (2026-09-07) — how many bins stack back-to-back in
  // the depth direction on ONE side before reaching the aisle. See
  // schema.prisma's own comment on Location.depthTier for the full design.
  const [depthTiers, setDepthTiers] = useState('1');
  const isGround = storageType === 'GROUND_FLOOR';
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<SimStep[]>([]);
  const [revealedCount, setRevealedCount] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [planMode, setPlanMode] = useState<'2d' | '3d'>('2d');
  const [colorMode, setColorMode] = useState<ColorMode>('class'); // Class, not Category, is the informative default here — every sim SKU shares the one auto-generated "Simulation" category, so Category mode would just paint everything one color.
  const [resetting, setResetting] = useState(false);
  // 3D cross-aisle spacing (2026-09-07) — same real company-configured
  // rendering input LocationsPage.tsx fetches, via the same broadly-
  // readable endpoint (not the COMPANY_ADMIN-only /companies/settings).
  // The sandbox is a fake warehouse, but the viewer's real company setting
  // still applies — same convention as every other real Company Settings
  // field this feature already reuses unchanged (occupancy overlay colors,
  // etc.).
  const [rackBaysPerCrossAisle, setRackBaysPerCrossAisle] = useState<number | null | undefined>(undefined);
  const [groundBinsPerCrossAisle, setGroundBinsPerCrossAisle] = useState<number | null | undefined>(undefined);

  // Plain fetch-and-set, no `loading` flag — reused after Run, which can
  // rebuild the sandbox's layout server-side (different Location rows
  // entirely, e.g. a new Levels/Depth) without needing a full "Setting up
  // the sandbox..." reload. Also called from loadSandbox() itself below.
  const refreshLocations = (warehouseId: string) => {
    return fetch(`http://localhost:3000/locations`, { headers: authHeaders() })
      .then((r) => (r.status === 401 ? [] : r.json()))
      .then((locs) => {
        setLocations(Array.isArray(locs) ? locs.filter((l: Location) => l.warehouseId === warehouseId) : []);
      });
  };

  const loadSandbox = () => {
    setLoading(true);
    setError('');
    fetch('http://localhost:3000/simulation/sandbox', { method: 'POST', headers: jsonHeaders() })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) {
          setError(errorText(data, 'Could not set up the simulation sandbox.'));
          setLoading(false);
          return;
        }
        setSandbox({ id: data.id, code: data.code, name: data.name });
        return refreshLocations(data.id).then(() => setLoading(false));
      });
  };

  useEffect(() => {
    loadSandbox();
    fetch('http://localhost:3000/companies/layout-settings', { headers: authHeaders() })
      .then((res) => (res.status === 401 || res.status === 403 ? null : res.json()))
      .then((data) => {
        if (!data) return;
        setRackBaysPerCrossAisle(data.rackBaysPerCrossAisle ?? null);
        setGroundBinsPerCrossAisle(data.groundBinsPerCrossAisle ?? null);
      });
  }, []);

  const handleRun = async () => {
    setRunning(true);
    setError('');
    setPlaying(false);
    const res = await fetch('http://localhost:3000/simulation/putaway/run', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        unitCount: Number(unitCount) || 20,
        storageType,
        levels: Number(levels) || 3,
        depth: Number(depth) || 1,
        racks: Number(racks) || 3,
        depthTiers: isGround ? Number(depthTiers) || 1 : undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setRunning(false);
      setError(errorText(data, 'Could not run the simulation.'));
      return;
    }
    // A Run can rebuild the sandbox's layout server-side (a different
    // Storage Type/Length/Levels/Depth than what's currently there — see
    // SimulationService.ensureSandbox()) — refresh `locations` so the Plan
    // View reflects whatever the backend actually has now, not whatever was
    // loaded on page mount. A real bug caught live: without this, changing
    // Levels/Depth and running again silently kept rendering the OLD
    // layout, even though the backend had genuinely rebuilt it (visible
    // only in the step text's rackName, never in the Plan View itself).
    await refreshLocations(data.warehouseId);
    setRunning(false);
    setSteps(data.steps);
    setRevealedCount(0);
    setPlaying(true);
  };

  const handleReset = async () => {
    setResetting(true);
    setError('');
    setPlaying(false);
    const res = await fetch('http://localhost:3000/simulation/sandbox/reset', { method: 'POST', headers: jsonHeaders() });
    const data = await res.json();
    setResetting(false);
    if (!res.ok) {
      setError(errorText(data, 'Could not reset the sandbox.'));
      return;
    }
    setSteps([]);
    setRevealedCount(0);
    loadSandbox();
  };

  // Playback — a plain setInterval revealing one more already-computed step
  // at a time. No network calls here at all; speed just changes the delay.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (playing && revealedCount < steps.length) {
      intervalRef.current = setInterval(() => {
        setRevealedCount((c) => {
          if (c + 1 >= steps.length) setPlaying(false);
          return Math.min(c + 1, steps.length);
        });
      }, BASE_DELAY_MS / speed);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [playing, speed, steps.length, revealedCount >= steps.length]);

  // Later steps win on SKU/Category/Class when a lane refills after
  // suggestBin() sends a second unit to the same location (same-SKU
  // top-up) — a plain Map keyed by locationId naturally keeps only the
  // most recent occupant identity per box, matching what a real occupancy
  // read would show either way. `quantity` is different: a top-up ADDS to
  // what's already there rather than replacing it, so it's summed across
  // every step landing on that location (2026-09-06 — click-to-inspect
  // gained an On-hand Qty line, "I need SKU details in it also").
  const occupancyMap = new Map<string, Occupancy>();
  for (const s of steps.slice(0, revealedCount)) {
    if (!s.locationId || s.needsBin) continue;
    const priorQty = occupancyMap.get(s.locationId)?.quantity ?? 0;
    occupancyMap.set(s.locationId, { locationId: s.locationId, skuId: s.skuId, skuCode: s.skuCode, categoryId: s.categoryId, categoryName: s.categoryName, abcClass: s.abcClass as any, quantity: priorQty + s.quantity });
  }
  const occupancy: Occupancy[] = [...occupancyMap.values()];

  const currentStep = revealedCount > 0 ? steps[revealedCount - 1] : null;
  const needsBinCount = steps.slice(0, revealedCount).filter((s) => s.needsBin).length;

  return (
    <div style={{ maxWidth: 1100, margin: '40px auto', fontFamily: 'sans-serif', padding: '0 16px' }}>
      <h1 style={{ textAlign: 'center' }}>Putaway Simulation</h1>
      <p style={{ textAlign: 'center', color: '#666', fontSize: 13, marginTop: -8, marginBottom: 24 }}>
        Runs a real batch of synthetic units through the actual Putaway bin-suggestion algorithm, against a
        dedicated sandbox warehouse — never a real one. Watch where and why each unit lands.
      </p>

      {loading ? (
        <p style={{ textAlign: 'center' }}>Setting up the sandbox...</p>
      ) : (
        <>
          {sandbox && (
            <p style={{ textAlign: 'center', fontSize: 12, color: '#888', marginTop: -8, marginBottom: 4 }}>
              Sandbox warehouse: <strong>{sandbox.code}</strong> — {sandbox.name}. This is never one of your real warehouses.
            </p>
          )}
          <p style={{ textAlign: 'center', fontSize: 12, color: '#888', marginTop: 0, marginBottom: 12 }}>
            Changing Storage Type/Length/Levels/Depth and running again rebuilds the sandbox's layout to match — this clears
            its current stock (same as Reset), so switch settings BEFORE a run you want to keep watching, not mid-way.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'center', marginBottom: 12, padding: 12, border: '1px solid #ccc', borderRadius: 8 }}>
            <label style={{ fontSize: 13 }}>Storage Type:</label>
            <select value={storageType} onChange={(e) => setStorageType(e.target.value)} disabled={running} style={{ padding: 6 }}>
              <option value="SPR">SPR</option>
              <option value="DRIVE_IN">Drive-in</option>
              <option value="ASRS">ASRS</option>
              <option value="GROUND_FLOOR">Ground/Floor</option>
            </select>
            {/* 2026-09-06 — Ground/Floor added (see [[wms-putaway-design]]).
                Same three inputs, relabeled for Ground since the backend
                reuses these exact fields with different meanings there:
                "Length" -> bins per flank (was rack positions per flank),
                "Levels" -> "Width" -> columns per bin (Ground never stacks
                vertically, so real Levels has no meaning for it), "Depth"
                keeps its identical meaning either way. */}
            <label style={{ fontSize: 13 }}>{isGround ? 'Bins (Length):' : 'Length:'}</label>
            <input type="number" min={1} max={30} value={racks} onChange={(e) => setRacks(e.target.value)} disabled={running} style={{ width: 60, padding: 6 }} />
            <label style={{ fontSize: 13 }}>{isGround ? 'Width (columns):' : 'Levels:'}</label>
            <input type="number" min={1} max={10} value={levels} onChange={(e) => setLevels(e.target.value)} disabled={running} style={{ width: 60, padding: 6 }} />
            <label style={{ fontSize: 13 }}>Depth:</label>
            <input type="number" min={1} max={6} value={depth} onChange={(e) => setDepth(e.target.value)} disabled={running} style={{ width: 60, padding: 6 }} />
            {isGround && (
              <>
                <label style={{ fontSize: 13 }} title="How many bins stack back-to-back going away from the aisle on each side, before reaching it. Each tier is its own separate bin.">
                  Depth Tiers:
                </label>
                <input type="number" min={1} max={4} value={depthTiers} onChange={(e) => setDepthTiers(e.target.value)} disabled={running} style={{ width: 60, padding: 6 }} />
              </>
            )}
            <label style={{ fontSize: 13 }}>Units to simulate:</label>
            <input type="number" min={1} max={200} value={unitCount} onChange={(e) => setUnitCount(e.target.value)} style={{ width: 70, padding: 6 }} />
            <button type="button" onClick={handleRun} disabled={running}>{running ? 'Running...' : 'Run Simulation'}</button>
            <button type="button" onClick={handleReset} disabled={resetting} style={{ color: 'crimson' }}>{resetting ? 'Resetting...' : 'Reset Sandbox'}</button>
            {steps.length > 0 && (
              <>
                <button type="button" onClick={() => setPlaying((p) => !p)} disabled={revealedCount >= steps.length}>
                  {playing ? 'Pause' : revealedCount >= steps.length ? 'Finished' : 'Play'}
                </button>
                <label style={{ fontSize: 13 }}>Speed:</label>
                {[1, 3, 5].map((s) => (
                  <button key={s} type="button" onClick={() => setSpeed(s)} style={{ fontWeight: speed === s ? 'bold' : 'normal' }}>{s}x</button>
                ))}
              </>
            )}
          </div>

          {error && <p style={{ color: 'crimson', textAlign: 'center' }}>{error}</p>}

          {steps.length > 0 && (
            <div style={{ textAlign: 'center', marginBottom: 12, fontSize: 13 }}>
              <strong>Step {revealedCount} / {steps.length}</strong>
              {currentStep && (
                currentStep.needsBin
                  ? <span style={{ color: 'crimson' }}> — {currentStep.skuCode} (Class {currentStep.abcClass}) needed a bin, none found</span>
                  : <span> — {currentStep.skuCode} (Class {currentStep.abcClass}), qty {currentStep.quantity} → {currentStep.rackName}</span>
              )}
              {needsBinCount > 0 && <span style={{ color: 'crimson' }}> ({needsBinCount} unit(s) so far needed a bin with none found)</span>}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 12 }}>
            <button type="button" onClick={() => setPlanMode('2d')} style={{ fontWeight: planMode === '2d' ? 'bold' : 'normal' }}>2D</button>
            <button type="button" onClick={() => setPlanMode('3d')} style={{ fontWeight: planMode === '3d' ? 'bold' : 'normal' }}>3D</button>
            <span style={{ marginLeft: 8, fontSize: 12, color: '#888' }}>Color by:</span>
            <button type="button" onClick={() => setColorMode('structural')} style={{ fontWeight: colorMode === 'structural' ? 'bold' : 'normal' }}>Structural</button>
            <button type="button" onClick={() => setColorMode('category')} style={{ fontWeight: colorMode === 'category' ? 'bold' : 'normal' }}>Category</button>
            <button type="button" onClick={() => setColorMode('class')} style={{ fontWeight: colorMode === 'class' ? 'bold' : 'normal' }}>A/B/C Class</button>
          </div>

          {planMode === '2d' ? (
            <LocationsPlanView locations={locations} warehouseLabel="Simulation Sandbox" colorMode={colorMode} occupancy={occupancy} />
          ) : (
            <Suspense fallback={<p style={{ marginTop: 16, color: '#666' }}>Loading 3D view…</p>}>
              <Locations3DView
                locations={locations}
                colorMode={colorMode}
                occupancy={occupancy}
                rackBaysPerCrossAisle={rackBaysPerCrossAisle}
                groundBinsPerCrossAisle={groundBinsPerCrossAisle}
              />
            </Suspense>
          )}
        </>
      )}
    </div>
  );
}

export default SimulationPage;

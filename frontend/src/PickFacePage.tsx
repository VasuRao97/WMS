import { useEffect, useState } from 'react';

// Pick Face (SPR only, 2026-09-05 — see [[wms-putaway-design]] in memory for
// the full design conversation). Tasks are never created here — a daily
// scheduled job (PickFaceReplenishmentScheduler) decides REFILL/EVICTION
// moves on its own; this page is purely the same scan-driven execution UX
// as Putaway (scan the source, then scan the destination the system tells
// you), reused deliberately so operators use the exact discipline they
// already know.

type Warehouse = { id: string; code: string; name: string };
type LocationRef = { id: string; code: string; storageType?: string; rack?: string | null; level?: string | null; depth?: number | null; flankNumber?: number | null };
type PickFaceTask = {
  id: string;
  sku: { id: string; code: string; description: string };
  fromLocation: LocationRef;
  toLocation: LocationRef;
  quantity: number;
  movedQuantity: number;
  status: 'PENDING' | 'COMPLETED';
  reason: 'REFILL' | 'EVICTION';
  inProgressTrip?: { id: string; quantity: number } | null;
};

const RACK_STORAGE_TYPES = ['SPR', 'DRIVE_IN', 'ASRS'];
function displayCode(loc?: LocationRef | null): string {
  if (!loc) return '';
  if (loc.storageType && RACK_STORAGE_TYPES.includes(loc.storageType) && loc.flankNumber != null && loc.rack && loc.level) {
    const parts = [`R${loc.flankNumber}`, loc.rack, `L${loc.level}`];
    if (loc.depth != null) parts.push(`D${loc.depth}`);
    return parts.join('-');
  }
  return loc.code;
}
type Trip = { id: string; quantity: number; task: PickFaceTask };

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('token')}` };
}
function jsonHeaders() {
  return { 'Content-Type': 'application/json', ...authHeaders() };
}
function errorText(data: any, fallback: string) {
  return Array.isArray(data?.message) ? data.message.join(' | ') : data?.message || fallback;
}

const STATUS_LABELS: Record<string, string> = { PENDING: 'Pending', COMPLETED: 'Completed' };
const REASON_LABELS: Record<string, string> = { REFILL: 'Refill (reserve → pick face)', EVICTION: 'Eviction (pick face → reserve)' };

function PickFacePage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [filterWarehouseId, setFilterWarehouseId] = useState('');
  const [tasks, setTasks] = useState<PickFaceTask[]>([]);

  const [barcode, setBarcode] = useState('');
  const [activeTrip, setActiveTrip] = useState<Trip | null>(null);
  const [locationCode, setLocationCode] = useState('');
  const [scanError, setScanError] = useState('');
  const [scanMsg, setScanMsg] = useState('');

  const loadTasks = () => {
    const qs = filterWarehouseId ? `?warehouseId=${filterWarehouseId}` : '';
    fetch(`http://localhost:3000/pick-face-tasks${qs}`, { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setTasks(Array.isArray(d) ? d : []));
  };
  useEffect(() => {
    fetch('http://localhost:3000/warehouses', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setWarehouses(Array.isArray(d) ? d : []));
  }, []);
  useEffect(() => { loadTasks(); }, [filterWarehouseId]);

  const handleClaim = async () => {
    setScanError('');
    setScanMsg('');
    if (!barcode.trim()) return;
    const res = await fetch('http://localhost:3000/pick-face-tasks/claim', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ barcode }) });
    const data = await res.json();
    if (!res.ok) {
      setScanError(errorText(data, 'Could not claim a trip for this barcode.'));
      return;
    }
    setActiveTrip(data);
    setBarcode('');
  };

  const handleCompleteTrip = async () => {
    if (!activeTrip) return;
    setScanError('');
    const res = await fetch(`http://localhost:3000/pick-face-tasks/trips/${activeTrip.id}/complete`, { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ locationCode }) });
    const data = await res.json();
    if (!res.ok) {
      setScanError(errorText(data, 'Could not complete this trip.'));
      return;
    }
    setScanMsg(`Trip completed — ${activeTrip.task.sku.code} placed at ${locationCode.toUpperCase()}.`);
    setActiveTrip(null);
    setLocationCode('');
    loadTasks();
  };

  return (
    <div style={{ maxWidth: 1100, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1 style={{ textAlign: 'center' }}>Pick Face</h1>
      <p style={{ textAlign: 'center', color: '#666', marginTop: -8 }}>
        SPR only. Tasks below are created automatically by a daily reslotting job — refilling an
        empty pick face with the highest-priority A/B-class SKU, or evicting a lower-class occupant
        for a higher one. Scan the source location/pallet, then scan the destination the system
        tells you — only a matching scan completes it.
      </p>

      <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>Scan Pick Face Move</h3>
        {!activeTrip ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              placeholder="Scan case/pallet barcode..." value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleClaim()}
              style={{ width: 260, padding: 8 }} autoFocus
            />
            <button onClick={handleClaim}>Claim</button>
          </div>
        ) : (
          <div>
            <p>
              <strong>{activeTrip.task.sku.code}</strong> — {activeTrip.task.sku.description} — take{' '}
              <strong>{Number(activeTrip.quantity)}</strong> from <strong>{displayCode(activeTrip.task.fromLocation)}</strong> to{' '}
              <strong>{displayCode(activeTrip.task.toLocation)}</strong>
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                placeholder="Scan destination location..." value={locationCode}
                onChange={(e) => setLocationCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCompleteTrip()}
                style={{ width: 260, padding: 8 }} autoFocus
              />
              <button onClick={handleCompleteTrip}>Complete</button>
              <button type="button" onClick={() => { setActiveTrip(null); setLocationCode(''); }}>Cancel</button>
            </div>
          </div>
        )}
        {scanError && <p style={{ color: 'crimson' }}>{scanError}</p>}
        {scanMsg && <p style={{ color: 'green' }}>{scanMsg}</p>}
      </div>

      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center', gap: 8 }}>
        <select value={filterWarehouseId} onChange={(e) => setFilterWarehouseId(e.target.value)} style={{ width: 200, padding: 6 }}>
          <option value="">All warehouses</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>{w.code}</option>
          ))}
        </select>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 32 }}>
        <thead>
          <tr style={{ textAlign: 'center', borderBottom: '2px solid #ccc' }}>
            <th style={{ padding: 8 }}>SKU</th>
            <th style={{ padding: 8 }}>Reason</th>
            <th style={{ padding: 8 }}>From</th>
            <th style={{ padding: 8 }}>To</th>
            <th style={{ padding: 8 }}>Qty</th>
            <th style={{ padding: 8 }}>Moved</th>
            <th style={{ padding: 8 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
              <td style={{ padding: 8 }}>{t.sku.code}</td>
              <td style={{ padding: 8 }}>{REASON_LABELS[t.reason]}</td>
              <td style={{ padding: 8 }}>{displayCode(t.fromLocation)}</td>
              <td style={{ padding: 8 }}>{displayCode(t.toLocation)}</td>
              <td style={{ padding: 8 }}>{Number(t.quantity)}</td>
              <td style={{ padding: 8 }}>{Number(t.movedQuantity)}</td>
              <td style={{ padding: 8 }}>{STATUS_LABELS[t.status]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {tasks.length === 0 && <p style={{ textAlign: 'center' }}>No pick face tasks found.</p>}
    </div>
  );
}

export default PickFacePage;

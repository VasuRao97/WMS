import { useEffect, useState } from 'react';

// Picking — task queue + scan-driven execution (2026-09-14, see CLAUDE.md's
// Outbound/Picking/Dispatch design section for the full conversation).
// Unlike Putaway, claiming needs no barcode scan (nothing physical is in
// hand yet) — a plain "Claim Next Task" button always grabs the oldest
// workable task, FIFO, regardless of which operator clicks it. Completion
// is two-tier: a whole-unit match needs only a location + pallet scan
// (cross-checked against the ledger), a partial/broken pick needs a
// location scan plus one barcode scan per individual unit.

type Warehouse = { id: string; code: string; name: string };
type LocationRef = { id: string; code: string; storageType?: string; rack?: string | null; level?: string | null; depth?: number | null; flankNumber?: number | null };
type PickTask = {
  id: string;
  sku: { id: string; code: string; description: string };
  fromLocation?: LocationRef | null;
  toLocation?: LocationRef | null;
  quantity: number;
  movedQuantity: number;
  status: 'NEEDS_SOURCE' | 'PENDING' | 'COMPLETED';
  inProgressTrip?: boolean;
  orderLine?: {
    isPriority: boolean;
    order: { orderNo: string; destinationCity: string };
  };
};
type Trip = { id: string; quantity: number; task: PickTask };

// Rack storage types (mirrors backend RACK_STORAGE_TYPES, ASRS removed
// 2026-09-13) — only these get a Rack Name; Ground/Stillage fall back to
// the raw code. Same formula as PutawayPage.tsx's own displayCode().
const RACK_STORAGE_TYPES = ['SPR', 'DRIVE_IN'];
function displayCode(loc?: LocationRef | null): string {
  if (!loc) return '—';
  if (loc.storageType && RACK_STORAGE_TYPES.includes(loc.storageType) && loc.flankNumber != null && loc.rack && loc.level) {
    const parts = [`R${loc.flankNumber}`, loc.rack, `L${loc.level}`];
    if (loc.depth != null) parts.push(`D${loc.depth}`);
    return parts.join('-');
  }
  return loc.code;
}

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('token')}` };
}
function jsonHeaders() {
  return { 'Content-Type': 'application/json', ...authHeaders() };
}
function errorText(data: any, fallback: string) {
  return Array.isArray(data?.message) ? data.message.join(' | ') : data?.message || fallback;
}

const STATUS_LABELS: Record<string, string> = { NEEDS_SOURCE: 'Needs Source', PENDING: 'Pending', COMPLETED: 'Completed' };

function PickTasksPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [filterWarehouseId, setFilterWarehouseId] = useState('');
  const [tasks, setTasks] = useState<PickTask[]>([]);

  const [activeTrip, setActiveTrip] = useState<Trip | null>(null);
  const [claimError, setClaimError] = useState('');
  const [claimBusy, setClaimBusy] = useState(false);

  const [locationCode, setLocationCode] = useState('');
  const [pickMode, setPickMode] = useState<'pallet' | 'unit'>('pallet');
  const [palletCode, setPalletCode] = useState('');
  const [unitBarcode, setUnitBarcode] = useState('');
  const [unitBarcodes, setUnitBarcodes] = useState<string[]>([]);
  const [completeError, setCompleteError] = useState('');
  const [completeMsg, setCompleteMsg] = useState('');

  const loadTasks = () => {
    const qs = filterWarehouseId ? `?warehouseId=${filterWarehouseId}` : '';
    fetch(`http://localhost:3000/pick-tasks${qs}`, { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setTasks(Array.isArray(d) ? d : []));
  };

  useEffect(() => {
    fetch('http://localhost:3000/warehouses', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setWarehouses(Array.isArray(d) ? d : []));
  }, []);
  useEffect(() => { loadTasks(); }, [filterWarehouseId]);

  const handleClaim = async () => {
    setClaimError('');
    setClaimBusy(true);
    const res = await fetch('http://localhost:3000/pick-tasks/claim', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ warehouseId: filterWarehouseId || undefined }),
    });
    const data = await res.json();
    setClaimBusy(false);
    if (!res.ok) {
      setClaimError(errorText(data, 'No workable picking task right now.'));
      return;
    }
    setActiveTrip(data);
    loadTasks();
  };

  const resetCompleteForm = () => {
    setLocationCode('');
    setPalletCode('');
    setUnitBarcode('');
    setUnitBarcodes([]);
    setCompleteError('');
  };

  const addUnitBarcode = () => {
    const v = unitBarcode.trim();
    if (!v) return;
    setUnitBarcodes((bs) => [...bs, v]);
    setUnitBarcode('');
  };

  const handleCompleteTrip = async () => {
    if (!activeTrip) return;
    setCompleteError('');
    const body: any = { locationCode };
    if (pickMode === 'pallet') body.palletCode = palletCode;
    else body.unitBarcodes = unitBarcodes;
    const res = await fetch(`http://localhost:3000/pick-tasks/trips/${activeTrip.id}/complete`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      setCompleteError(errorText(data, 'Could not complete this trip.'));
      return;
    }
    setCompleteMsg(`Trip completed — ${activeTrip.task.sku.code} picked from ${locationCode.toUpperCase()}.`);
    setActiveTrip(null);
    resetCompleteForm();
    loadTasks();
  };

  return (
    <div style={{ maxWidth: 1100, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1 style={{ textAlign: 'center' }}>Picking</h1>
      <p style={{ textAlign: 'center', color: '#666', marginTop: -8 }}>
        Claim the next task — no barcode needed, the queue is FIFO regardless of who claims it — then scan
        the pallet (whole-unit pick) or each individual unit (partial pick) after scanning the location.
      </p>

      <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>Pick a Trip</h3>
        {!activeTrip ? (
          <div>
            <button onClick={handleClaim} disabled={claimBusy}>
              {claimBusy ? 'Claiming...' : 'Claim Next Task'}
            </button>
            {claimError && <p style={{ color: 'crimson' }}>{claimError}</p>}
          </div>
        ) : (
          <div>
            <p>
              <strong>{activeTrip.task.sku.code}</strong> — {activeTrip.task.sku.description} — take{' '}
              <strong>{Number(activeTrip.quantity)}</strong> from <strong>{displayCode(activeTrip.task.fromLocation)}</strong> to{' '}
              <strong>{displayCode(activeTrip.task.toLocation)}</strong>
              {activeTrip.task.orderLine && (
                <> — Order {activeTrip.task.orderLine.order.orderNo} ({activeTrip.task.orderLine.order.destinationCity})</>
              )}
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <input
                placeholder="Scan source location..." value={locationCode}
                onChange={(e) => setLocationCode(e.target.value)}
                style={{ width: 220 }} autoFocus
              />
            </div>
            <div style={{ marginBottom: 8 }}>
              <label style={{ marginRight: 16 }}>
                <input type="radio" name="pickMode" checked={pickMode === 'pallet'} onChange={() => setPickMode('pallet')} /> Whole pallet
              </label>
              <label>
                <input type="radio" name="pickMode" checked={pickMode === 'unit'} onChange={() => setPickMode('unit')} /> Partial / individual units
              </label>
            </div>
            {pickMode === 'pallet' ? (
              <input
                placeholder="Scan pallet code..." value={palletCode}
                onChange={(e) => setPalletCode(e.target.value)}
                style={{ width: 220 }}
              />
            ) : (
              <div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    placeholder="Scan unit barcode..." value={unitBarcode}
                    onChange={(e) => setUnitBarcode(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addUnitBarcode()}
                    style={{ width: 220 }}
                  />
                  <button type="button" onClick={addUnitBarcode}>Add</button>
                </div>
                {unitBarcodes.length > 0 && (
                  <p style={{ fontSize: 13, color: '#444' }}>
                    Scanned {unitBarcodes.length}: {unitBarcodes.join(', ')}
                    <button type="button" onClick={() => setUnitBarcodes([])} style={{ marginLeft: 8 }}>Clear</button>
                  </p>
                )}
              </div>
            )}
            <div style={{ marginTop: 8 }}>
              <button onClick={handleCompleteTrip}>Complete</button>
              <button type="button" onClick={() => { setActiveTrip(null); resetCompleteForm(); }} style={{ marginLeft: 8 }}>Cancel</button>
            </div>
            {completeError && <p style={{ color: 'crimson' }}>{completeError}</p>}
          </div>
        )}
        {completeMsg && <p style={{ color: 'green' }}>{completeMsg}</p>}
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
            <th style={{ padding: 8 }}>Order</th>
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
              <td style={{ padding: 8 }}>
                {t.orderLine ? `${t.orderLine.order.orderNo}${t.orderLine.isPriority ? ' ⭑' : ''}` : '—'}
              </td>
              <td style={{ padding: 8 }}>{displayCode(t.fromLocation)}</td>
              <td style={{ padding: 8 }}>{displayCode(t.toLocation)}</td>
              <td style={{ padding: 8 }}>{Number(t.quantity)}</td>
              <td style={{ padding: 8 }}>{Number(t.movedQuantity)}</td>
              <td style={{ padding: 8 }}>{STATUS_LABELS[t.status]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {tasks.length === 0 && <p style={{ textAlign: 'center' }}>No picking tasks found.</p>}
    </div>
  );
}

export default PickTasksPage;

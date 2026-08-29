import { useEffect, useState } from 'react';

// The first page in a new "Insights" section (2026-08-29) — deliberately
// standalone, not folded into Locations/Putaway/Warehouses, since the
// client's own framing is that this is the start of a real reporting
// destination ("valuable insights" to share with clients), not a one-off
// debug aid bolted onto an existing page. First report: per-ABC-class
// storage utilization — see [[wms-putaway-design]] in memory for the
// design conversation and backend/src/insights/insights.service.ts for the
// computation itself.

function authHeaders() {
  const token = localStorage.getItem('token');
  return { Authorization: `Bearer ${token}` };
}

type Warehouse = { id: string; code: string; name: string };
type ClassRow = { abcClass: 'A' | 'B' | 'C'; lanesUsed: number; binsAllotted: number; binsUsed: number; utilizationPct: number | null };

const CLASS_COLORS: Record<string, string> = { A: '#2e7d32', B: '#1565c0', C: '#6a1b9a' };

function InsightsPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [classes, setClasses] = useState<ClassRow[] | null>(null);
  const [warehouseCode, setWarehouseCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('http://localhost:3000/warehouses', { headers: authHeaders() })
      .then((res) => (res.status === 401 ? null : res.json()))
      .then((data: Warehouse[] | null) => {
        if (!data) return;
        setWarehouses(data);
        if (data.length > 0) setWarehouseId(data[0].id);
      });
  }, []);

  useEffect(() => {
    if (!warehouseId) return;
    setLoading(true);
    setError('');
    fetch(`http://localhost:3000/insights/storage-utilization?warehouseId=${warehouseId}`, { headers: authHeaders() })
      .then((res) => {
        if (res.status === 401) { localStorage.clear(); window.location.reload(); return null; }
        return res.json().then((data) => ({ ok: res.ok, data }));
      })
      .then((result) => {
        setLoading(false);
        if (!result) return;
        if (!result.ok) {
          setError(Array.isArray(result.data?.message) ? result.data.message.join(' | ') : result.data?.message || 'Could not load storage utilization.');
          setClasses(null);
          return;
        }
        setClasses(result.data.classes);
        setWarehouseCode(result.data.warehouseCode);
      });
  }, [warehouseId]);

  return (
    <div style={{ maxWidth: 900, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1 style={{ textAlign: 'center' }}>Insights</h1>

      <div style={{ display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center', marginBottom: 24 }}>
        <label style={{ fontSize: 13, fontWeight: 'bold' }}>Warehouse</label>
        <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} style={{ padding: 6, minWidth: 200 }}>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
          ))}
        </select>
      </div>

      <h3 style={{ textAlign: 'center', marginBottom: 4 }}>Storage Utilization by ABC Class</h3>
      <p style={{ textAlign: 'center', color: '#888', fontSize: 13, marginTop: 0, marginBottom: 20 }}>
        Of the rack-storage bins actually holding stock for each class, how much of that space is really being used
        — a lane sitting mostly empty (e.g. one small SKU alone in a 3-deep lane) shows up as low utilization here.
        Empty lanes (nothing of any class in them) aren't counted. Warehouse: {warehouseCode || '—'}.
      </p>

      {error && <p style={{ color: 'crimson', textAlign: 'center' }}>{error}</p>}
      {loading && <p style={{ textAlign: 'center', color: '#888' }}>Loading...</p>}

      {classes && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 16, flexWrap: 'wrap' }}>
          {classes.map((row) => (
            <div
              key={row.abcClass}
              style={{
                border: '1px solid #ccc', borderRadius: 8, padding: 20, minWidth: 200, textAlign: 'center',
                borderTop: `4px solid ${CLASS_COLORS[row.abcClass]}`,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 'bold', color: '#666' }}>Class {row.abcClass}</div>
              <div style={{ fontSize: 36, fontWeight: 'bold', color: CLASS_COLORS[row.abcClass], margin: '8px 0' }}>
                {row.utilizationPct == null ? '—' : `${row.utilizationPct}%`}
              </div>
              {row.utilizationPct == null ? (
                <div style={{ fontSize: 12, color: '#888' }}>No {row.abcClass}-class lanes in use</div>
              ) : (
                <>
                  <div style={{ fontSize: 13, color: '#444' }}>{row.binsUsed} of {row.binsAllotted} bins used</div>
                  <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>across {row.lanesUsed} lane{row.lanesUsed === 1 ? '' : 's'}</div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default InsightsPage;

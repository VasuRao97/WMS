import { useEffect, useState } from 'react';

// ABC Velocity Reassessment (2026-09-06 — see [[wms-abc-velocity-design]] in
// memory for the full design conversation, and Company Settings' own "ABC
// Velocity Reassessment" section for the toggle/cutoffs). The client's own
// distrust of a manually-typed/imported SKU Master abcClass ("i wont
// believe the import ABC class, as it can be a one time master dump") —
// this page runs and shows the real, computed, WAREHOUSE-scoped result
// ("SKUS should be region specific... in kashmir you wont sell coke a lot?
// but its A item you might sell minute maid the most"). "Run Reassessment
// Now" is the same computation the monthly cron runs, on demand — a client
// shouldn't have to wait for the 1st of the month to see this work.

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('token')}` };
}
function jsonHeaders() {
  return { 'Content-Type': 'application/json', ...authHeaders() };
}
function errorText(data: any, fallback: string) {
  return Array.isArray(data?.message) ? data.message.join(' | ') : data?.message || fallback;
}

type Warehouse = { id: string; code: string; name: string };
type ClassRow = {
  skuCode: string;
  skuDescription: string;
  categoryName: string | null;
  warehouseCode: string;
  warehouseId: string;
  computedClass: string;
  manualClass: string | null;
  dispatchedQty: number;
  fmsClass: string | null;
  orderCount: number | null;
  computedAt: string;
};

const CLASS_COLORS: Record<string, string> = { A: '#16a34a', B: '#d97706', C: '#dc2626', D: '#6b7280' };
// FMS (2026-09-08 — see [[wms-abc-velocity-design]] in memory) — a genuinely
// different axis from ABC above (movement frequency, not quantity), its own
// color scale so it's never visually confused with the ABC column next to it.
const FMS_COLORS: Record<string, string> = { F: '#16a34a', M: '#d97706', S: '#2563eb' };

function AbcClassificationPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [rows, setRows] = useState<ClassRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState('');
  const [runErr, setRunErr] = useState('');

  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);
  const [importError, setImportError] = useState('');

  useEffect(() => {
    fetch('http://localhost:3000/warehouses', { headers: authHeaders() })
      .then((res) => (res.status === 401 ? [] : res.json()))
      .then((data) => setWarehouses(Array.isArray(data) ? data : []));
  }, []);

  const loadCurrent = () => {
    setLoading(true);
    const qs = warehouseId ? `?warehouseId=${warehouseId}` : '';
    fetch(`http://localhost:3000/abc-classification/current${qs}`, { headers: authHeaders() })
      .then((r) => (r.status === 401 ? [] : r.json()))
      .then((d) => {
        setRows(Array.isArray(d) ? d : []);
        setLoading(false);
      });
  };
  useEffect(() => { loadCurrent(); }, [warehouseId]);

  const handleRunNow = async () => {
    setRunning(true);
    setRunMsg('');
    setRunErr('');
    const res = await fetch('http://localhost:3000/abc-classification/run', { method: 'POST', headers: jsonHeaders() });
    const data = await res.json();
    setRunning(false);
    if (!res.ok) {
      setRunErr(errorText(data, 'Could not run the reassessment.'));
      return;
    }
    setRunMsg(`Done — ${data.warehousesProcessed} warehouse(s) reassessed.`);
    loadCurrent();
  };

  const handleImport = async () => {
    if (!importFile) return;
    setImporting(true);
    setImportError('');
    setImportResult(null);
    const formData = new FormData();
    formData.append('file', importFile);
    const res = await fetch('http://localhost:3000/abc-classification/historical-dispatch/import', { method: 'POST', headers: authHeaders(), body: formData });
    const data = await res.json();
    setImporting(false);
    if (!res.ok) {
      setImportError(errorText(data, 'Could not import this file.'));
      return;
    }
    setImportResult(data);
  };

  return (
    <div style={{ maxWidth: 1100, margin: '40px auto', fontFamily: 'sans-serif', padding: '0 16px' }}>
      <h1 style={{ textAlign: 'center' }}>ABC Classification</h1>
      <p style={{ textAlign: 'center', color: '#888', fontSize: 13, marginTop: -8, marginBottom: 24 }}>
        Real, computed A/B/C/D classes per SKU per warehouse, derived from actual trailing dispatch quantity — never
        the same class company-wide, since the same SKU can move fast in one warehouse and barely move in another.
        Also computes an FMS (Fast/Medium/Slow) class from dispatch order count — a different axis (how often vs.
        how much) that Putaway now uses alongside ABC. Configure the cutoffs and enable the monthly job on Company
        Settings.
      </p>

      <div style={{ display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center', marginBottom: 16 }}>
        <label style={{ fontSize: 13, fontWeight: 'bold' }}>Warehouse</label>
        <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} style={{ padding: 6, minWidth: 200 }}>
          <option value="">All warehouses</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
          ))}
        </select>
        <button type="button" onClick={handleRunNow} disabled={running}>{running ? 'Running...' : 'Run Reassessment Now'}</button>
      </div>
      {runMsg && <p style={{ textAlign: 'center', color: 'green' }}>{runMsg}</p>}
      {runErr && <p style={{ textAlign: 'center', color: 'crimson' }}>{runErr}</p>}

      {loading ? (
        <p style={{ textAlign: 'center' }}>Loading...</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 32 }}>
          <thead>
            <tr style={{ textAlign: 'center', borderBottom: '2px solid #ccc' }}>
              <th style={{ padding: 8 }}>Warehouse</th>
              <th style={{ padding: 8 }}>SKU</th>
              <th style={{ padding: 8 }}>Category</th>
              <th style={{ padding: 8 }}>Computed Class (ABC)</th>
              <th style={{ padding: 8 }}>SKU Master Class</th>
              <th style={{ padding: 8 }}>Dispatched Qty</th>
              <th style={{ padding: 8 }}>FMS Class</th>
              <th style={{ padding: 8 }}>Order Count</th>
              <th style={{ padding: 8 }}>Computed At</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
                <td style={{ padding: 8 }}>{r.warehouseCode}</td>
                <td style={{ padding: 8 }}>{r.skuCode}</td>
                <td style={{ padding: 8 }}>{r.categoryName || '—'}</td>
                <td style={{ padding: 8, fontWeight: 'bold', color: CLASS_COLORS[r.computedClass] }}>{r.computedClass}</td>
                <td style={{ padding: 8, color: '#888' }}>{r.manualClass || '—'}</td>
                <td style={{ padding: 8 }}>{Number(r.dispatchedQty)}</td>
                <td style={{ padding: 8, fontWeight: 'bold', color: r.fmsClass ? FMS_COLORS[r.fmsClass] : undefined }}>{r.fmsClass || '—'}</td>
                <td style={{ padding: 8 }}>{r.orderCount != null ? Number(r.orderCount) : '—'}</td>
                <td style={{ padding: 8 }}>{new Date(r.computedAt).toLocaleString()}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={9} style={{ padding: 12, color: '#888' }}>No computed classifications yet — enable the feature in Company Settings, then run it.</td></tr>
            )}
          </tbody>
        </table>
      )}

      <div style={{ padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>Historical Dispatch Import</h3>
        <p style={{ marginTop: -4, marginBottom: 12, fontSize: 13, color: '#888' }}>
          Bootstrap real trailing-window history before it naturally accumulates — one row per SKU × Warehouse ×
          Month. Columns: <code>SKU Code</code>, <code>Warehouse Code</code>, <code>Month</code> (e.g. "2026-06"),{' '}
          <code>Quantity</code>, and an optional <code>Order Count</code> (how many separate dispatches that
          quantity came from — feeds FMS above; leave blank if only bootstrapping ABC).
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="file" accept=".xlsx" onChange={(e) => setImportFile(e.target.files?.[0] || null)} />
          <button type="button" onClick={handleImport} disabled={!importFile || importing}>{importing ? 'Importing...' : 'Import'}</button>
        </div>
        {importError && <p style={{ color: 'crimson' }}>{importError}</p>}
        {importResult && (
          <div style={{ marginTop: 12 }}>
            <p>{importResult.successCount} succeeded, {importResult.failCount} failed, out of {importResult.totalRows}.</p>
            {importResult.results.filter((r: any) => r.status === 'error').length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: 'center', borderBottom: '1px solid #ccc' }}>
                    <th style={{ padding: 4 }}>Row</th>
                    <th style={{ padding: 4 }}>SKU Code</th>
                    <th style={{ padding: 4 }}>Warehouse Code</th>
                    <th style={{ padding: 4 }}>Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {importResult.results.filter((r: any) => r.status === 'error').map((r: any, i: number) => (
                    <tr key={i} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
                      <td style={{ padding: 4 }}>{r.row}</td>
                      <td style={{ padding: 4 }}>{r.skuCode}</td>
                      <td style={{ padding: 4 }}>{r.warehouseCode}</td>
                      <td style={{ padding: 4, color: 'crimson' }}>{(r.errors || []).join('; ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default AbcClassificationPage;

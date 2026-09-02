import { useEffect, useState } from 'react';

// Pallet Master (2026-09-01) — see [[wms-putaway-design]] in memory for the
// full design conversation ("marrying" loose cases onto a pallet before
// Putaway). Same shape as LocationsPage's own generator: bulk range-create
// (no manual single-add, matching the "generator/import creates, page only
// edits" convention), a table list, Download Labels (same Code128 mechanism
// as Location Labels), and a standing Delete All. Occasional-edit master
// data, not a daily workflow — lives under the Masters dropdown, not
// top-level (the daily marrying/scanning workflow itself lives on Inbound
// Orders' Receiving modal, not here).

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
type Pallet = {
  id: string;
  code: string;
  status: 'AVAILABLE' | 'IN_USE';
  isActive: boolean;
  loads: { id: string; sku: { code: string; description: string } }[];
};
type GenerateResult = { id?: string; code: string; status: 'success' | 'error'; errors?: string[] };

function PalletsPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [pallets, setPallets] = useState<Pallet[]>([]);
  const [search, setSearch] = useState('');
  const [deleteAllResult, setDeleteAllResult] = useState('');

  const [codePrefix, setCodePrefix] = useState('PLT');
  const [range, setRange] = useState('');
  const [generateResults, setGenerateResults] = useState<GenerateResult[] | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState('');

  const loadWarehouses = () => {
    fetch('http://localhost:3000/warehouses', { headers: authHeaders() })
      .then((res) => (res.status === 401 ? [] : res.json()))
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        setWarehouses(list);
        setWarehouseId((prev) => prev || (list[0]?.id ?? ''));
      });
  };

  const loadPallets = (whId: string) => {
    if (!whId) { setPallets([]); return; }
    fetch(`http://localhost:3000/pallets?warehouseId=${whId}`, { headers: authHeaders() })
      .then((res) => (res.status === 401 ? [] : res.json()))
      .then((data) => setPallets(Array.isArray(data) ? data : []));
  };

  useEffect(() => { loadWarehouses(); }, []);
  useEffect(() => { loadPallets(warehouseId); }, [warehouseId]);

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    setGenerateError('');
    setGenerateResults(null);
    if (!warehouseId) { setGenerateError('Select a warehouse first.'); return; }
    setGenerating(true);
    const res = await fetch('http://localhost:3000/pallets/generate', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ warehouseId, codePrefix, range }),
    });
    const data = await res.json();
    setGenerating(false);
    if (!res.ok) {
      setGenerateError(errorText(data, 'Could not generate pallets.'));
      return;
    }
    setGenerateResults(data);
    loadPallets(warehouseId);
  };

  const handleDownloadLabels = async (palletIds: string[]) => {
    if (palletIds.length === 0) return;
    const res = await fetch('http://localhost:3000/pallets/labels', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ palletIds }),
    });
    if (!res.ok) { alert('Could not generate labels.'); return; }
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Pallet_Labels.zip';
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const handleDeactivate = async (id: string, isActive: boolean) => {
    const action = isActive ? 'deactivate' : 'reactivate';
    await fetch(`http://localhost:3000/pallets/${id}/${action}`, { method: 'PATCH', headers: authHeaders() });
    loadPallets(warehouseId);
  };

  const handleDeleteAll = async () => {
    if (!confirm('Permanently delete ALL pallets in this company that have never been loaded? This cannot be undone.')) return;
    const res = await fetch('http://localhost:3000/pallets/all', { method: 'DELETE', headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) {
      setDeleteAllResult(`Delete All failed: ${errorText(data, 'Unknown error.')}`);
      return;
    }
    setDeleteAllResult(
      `Deleted ${data.deletedCount} pallet(s). ${data.blockedCount} blocked (have load history)${data.blockedCodes.length ? ': ' + data.blockedCodes.join(', ') : ''}.`,
    );
    loadPallets(warehouseId);
  };

  const filtered = pallets.filter((p) => !search || p.code.toLowerCase().includes(search.toLowerCase()));
  const justGeneratedIds = (generateResults || []).filter((r) => r.status === 'success' && r.id).map((r) => r.id!) as string[];

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: 20 }}>
      <h2 style={{ textAlign: 'center' }}>Pallet Master</h2>
      <p style={{ textAlign: 'center', color: '#666', fontSize: 13, marginTop: -8 }}>
        Physical pallet assets for Pallet consolidation ("marrying" loose cases onto a pallet before Putaway) — registered here in
        bulk, loaded/closed during Inbound receiving on the Inbound Orders page.
      </p>

      <div style={{ textAlign: 'center', marginBottom: 20 }}>
        <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} style={{ padding: 6, minWidth: 220 }}>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
          ))}
        </select>
      </div>

      <div style={{ padding: 16, border: '1px solid #ccc', borderRadius: 8, marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>Generate Pallets</h3>
        <form onSubmit={handleGenerate} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#666' }}>Code Prefix</label>
            <input value={codePrefix} onChange={(e) => setCodePrefix(e.target.value)} style={{ width: 90, padding: 6 }} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#666' }}>Number / Range (e.g. 0001-0100)</label>
            <input value={range} onChange={(e) => setRange(e.target.value)} placeholder="0001-0100" style={{ width: 160, padding: 6 }} />
          </div>
          <button type="submit" disabled={generating}>{generating ? 'Generating...' : 'Generate'}</button>
        </form>
        {generateError && <p style={{ color: 'crimson' }}>{generateError}</p>}
        {generateResults && (
          <div style={{ marginTop: 12 }}>
            <p>
              {generateResults.filter((r) => r.status === 'success').length} created,{' '}
              {generateResults.filter((r) => r.status === 'error').length} skipped.
            </p>
            {justGeneratedIds.length > 0 && (
              <button type="button" onClick={() => handleDownloadLabels(justGeneratedIds)}>
                Download Labels for {justGeneratedIds.length} generated pallet(s)
              </button>
            )}
            {generateResults.filter((r) => r.status === 'error').map((r, i) => (
              <p key={i} style={{ color: 'crimson', fontSize: 12 }}>{r.code}: {(r.errors || []).join(', ')}</p>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, justifyContent: 'center' }}>
        <input placeholder="Search code..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ padding: 6, width: 200 }} />
        <button type="button" onClick={() => handleDownloadLabels(filtered.map((p) => p.id))} disabled={filtered.length === 0}>
          Download Labels for {filtered.length} shown
        </button>
        <button type="button" onClick={handleDeleteAll} style={{ color: 'crimson' }}>Delete All</button>
      </div>
      {deleteAllResult && <p style={{ textAlign: 'center' }}>{deleteAllResult}</p>}

      <table style={{ width: '100%', borderCollapse: 'collapse', margin: '0 auto' }}>
        <thead>
          <tr style={{ textAlign: 'center', borderBottom: '1px solid #ccc' }}>
            <th style={{ padding: 6 }}>Code</th>
            <th style={{ padding: 6 }}>Status</th>
            <th style={{ padding: 6 }}>Current Load</th>
            <th style={{ padding: 6 }}>Active</th>
            <th style={{ padding: 6 }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((p) => (
            <tr key={p.id} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
              <td style={{ padding: 6 }}>{p.code}</td>
              <td style={{ padding: 6 }}>{p.status === 'IN_USE' ? 'In use' : 'Available'}</td>
              <td style={{ padding: 6, color: p.loads[0] ? undefined : '#888' }}>
                {p.loads[0] ? `${p.loads[0].sku.code} — ${p.loads[0].sku.description}` : '—'}
              </td>
              <td style={{ padding: 6 }}>{p.isActive ? 'Yes' : 'No'}</td>
              <td style={{ padding: 6 }}>
                <button type="button" onClick={() => handleDeactivate(p.id, p.isActive)}>{p.isActive ? 'Deactivate' : 'Reactivate'}</button>
              </td>
            </tr>
          ))}
          {filtered.length === 0 && (
            <tr><td colSpan={5} style={{ padding: 12, color: '#888' }}>No pallets yet — generate a batch above.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default PalletsPage;

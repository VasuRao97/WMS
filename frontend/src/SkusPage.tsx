import { useEffect, useState } from 'react';

type StorageUnit = { id: string; unitType: string; qtyInBaseUom: number; isPreferred: boolean };
type Barcode = { id: string; barcode: string; type: string };
type Sku = {
  id: string;
  code: string;
  description: string;
  category: string;
  baseUom: string;
  hsnCode: string;
  storageCondition: string;
  shelfLifeTracked: boolean;
  shelfLifeDays?: number;
  isActive: boolean;
  storageUnits: StorageUnit[];
  barcodes: Barcode[];
};

type ImportResultRow = { row: number; code: string; status: 'success' | 'error'; errors?: string[] };
type ImportSummary = { totalRows: number; successCount: number; failCount: number; results: ImportResultRow[] };

type Summary = {
  total: number;
  active: number;
  inactive: number;
  hazmatCount: number;
  batchTrackedCount: number;
  shelfLifeTrackedCount: number;
  byCategory: Record<string, number>;
  byAbc: Record<string, number>;
};

function authHeaders() {
  const token = localStorage.getItem('token');
  return { Authorization: `Bearer ${token}` };
}

function SkusPage() {
  const [skus, setSkus] = useState<Sku[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [search, setSearch] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportSummary | null>(null);
  const [deleteAllResult, setDeleteAllResult] = useState<string | null>(null);

  const loadSkus = () => {
    fetch('http://localhost:3000/skus', { headers: authHeaders() })
      .then((res) => res.json())
      .then((data) => setSkus(data));
  };

  const loadSummary = () => {
    fetch('http://localhost:3000/skus/summary', { headers: authHeaders() })
      .then((res) => res.json())
      .then((data) => setSummary(data));
  };

  const refreshAll = () => {
    loadSkus();
    loadSummary();
  };

  useEffect(() => {
    refreshAll();
  }, []);

  const handleImport = async () => {
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('http://localhost:3000/skus/import', {
      method: 'POST',
      headers: authHeaders(),
      body: formData,
    });
    const data = await res.json();
    setImportResult(data);
    setImporting(false);
    setFile(null);
    refreshAll();
  };

  const handleExport = () => {
    const token = localStorage.getItem('token');
    fetch('http://localhost:3000/skus/export', { headers: authHeaders() })
      .then((res) => res.blob())
      .then((blob) => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'SKU_Master_Export.xlsx';
        a.click();
        window.URL.revokeObjectURL(url);
      });
  };

  const handleDeactivate = async (id: string, isActive: boolean) => {
    const action = isActive ? 'deactivate' : 'reactivate';
    await fetch(`http://localhost:3000/skus/${id}/${action}`, { method: 'PATCH', headers: authHeaders() });
    refreshAll();
  };

  const handleDelete = async (id: string, code: string) => {
    if (!confirm(`Permanently delete ${code}? This cannot be undone.`)) return;
    const res = await fetch(`http://localhost:3000/skus/${id}`, { method: 'DELETE', headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) {
      alert(data.message || 'Could not delete this SKU.');
      return;
    }
    refreshAll();
  };

  const handleDeleteAll = async () => {
    if (!confirm('Permanently delete ALL SKUs that have no transaction history? This cannot be undone.')) return;
    const res = await fetch('http://localhost:3000/skus/all', { method: 'DELETE', headers: authHeaders() });
    const data = await res.json();
    setDeleteAllResult(
      `Deleted ${data.deletedCount} SKU(s). ${data.blockedCount} blocked (have transaction history)${data.blockedCodes.length ? ': ' + data.blockedCodes.join(', ') : ''}.`,
    );
    refreshAll();
  };

  const filtered = skus.filter(
    (s) =>
      s.code.toLowerCase().includes(search.toLowerCase()) ||
      s.description.toLowerCase().includes(search.toLowerCase()) ||
      s.category.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div style={{ maxWidth: 1000, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1>SKU Master</h1>

      {summary && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
          <div style={cardStyle}><strong>{summary.total}</strong><div>Total SKUs</div></div>
          <div style={cardStyle}><strong>{summary.active}</strong><div>Active</div></div>
          <div style={cardStyle}><strong>{summary.inactive}</strong><div>Inactive</div></div>
          <div style={cardStyle}><strong>{summary.hazmatCount}</strong><div>Hazmat</div></div>
          <div style={cardStyle}><strong>{summary.batchTrackedCount}</strong><div>Batch Tracked</div></div>
          <div style={cardStyle}><strong>{summary.shelfLifeTrackedCount}</strong><div>Shelf-Life Tracked</div></div>
          <div style={{ ...cardStyle, minWidth: 200 }}>
            <div style={{ fontWeight: 'bold', marginBottom: 4 }}>By Category</div>
            {Object.entries(summary.byCategory).map(([cat, count]) => (
              <div key={cat} style={{ fontSize: 13 }}>{cat}: {count}</div>
            ))}
          </div>
          <div style={{ ...cardStyle, minWidth: 160 }}>
            <div style={{ fontWeight: 'bold', marginBottom: 4 }}>By ABC Class</div>
            {Object.entries(summary.byAbc).map(([abc, count]) => (
              <div key={abc} style={{ fontSize: 13 }}>{abc}: {count}</div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>Import from Excel</h3>
        <input type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files ? e.target.files[0] : null)} />
        <button onClick={handleImport} disabled={!file || importing} style={{ marginLeft: 8 }}>
          {importing ? 'Importing...' : 'Import'}
        </button>
        <button onClick={handleExport} style={{ marginLeft: 8 }}>Export to Excel</button>
        <button onClick={handleDeleteAll} style={{ marginLeft: 8, color: 'crimson' }}>Delete All</button>

        {importResult && (
          <div style={{ marginTop: 16 }}>
            <p><strong>{importResult.successCount}</strong> succeeded, <strong>{importResult.failCount}</strong> failed, out of {importResult.totalRows} rows.</p>
            <ul style={{ maxHeight: 200, overflowY: 'auto' }}>
              {importResult.results.map((r) => (
                <li key={r.row} style={{ color: r.status === 'error' ? 'crimson' : 'green' }}>
                  Row {r.row} ({r.code}): {r.status === 'success' ? 'Imported' : r.errors?.join('; ')}
                </li>
              ))}
            </ul>
          </div>
        )}
        {deleteAllResult && <p style={{ marginTop: 12 }}>{deleteAllResult}</p>}
      </div>

      <input
        placeholder="Search by code, description, or category..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ width: '100%', padding: 8, marginBottom: 16, boxSizing: 'border-box' }}
      />

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #ccc' }}>
            <th style={{ padding: 8 }}>Code</th>
            <th style={{ padding: 8 }}>Description</th>
            <th style={{ padding: 8 }}>Category</th>
            <th style={{ padding: 8 }}>Storage Units</th>
            <th style={{ padding: 8 }}>Barcodes</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((sku) => (
            <tr key={sku.id} style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: 8, fontWeight: 'bold' }}>{sku.code}</td>
              <td style={{ padding: 8 }}>{sku.description}</td>
              <td style={{ padding: 8 }}>{sku.category}</td>
              <td style={{ padding: 8 }}>
                {sku.storageUnits.map((u) => `${u.unitType}=${u.qtyInBaseUom}${u.isPreferred ? ' *' : ''}`).join(', ')}
              </td>
              <td style={{ padding: 8 }}>{sku.barcodes.map((b) => b.barcode).join(', ') || '—'}</td>
              <td style={{ padding: 8 }}>{sku.isActive ? 'Active' : 'Inactive'}</td>
              <td style={{ padding: 8, whiteSpace: 'nowrap' }}>
                <button onClick={() => handleDeactivate(sku.id, sku.isActive)}>
                  {sku.isActive ? 'Deactivate' : 'Reactivate'}
                </button>
                <button onClick={() => handleDelete(sku.id, sku.code)} style={{ marginLeft: 6, color: 'crimson' }}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {filtered.length === 0 && <p style={{ marginTop: 16 }}>No SKUs found.</p>}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  border: '1px solid #ccc',
  borderRadius: 8,
  padding: '12px 16px',
  textAlign: 'center',
  minWidth: 100,
};

export default SkusPage;
import { useEffect, useState } from 'react';

type StorageUnit = { id: string; unitType: string; qtyInBaseUom: number; isPreferred: boolean };
type Barcode = { id: string; barcode: string; type: string };
type ProductCategory = { id: string; name: string };
type Sku = {
  id: string;
  code: string;
  description: string;
  category: ProductCategory;
  primaryStorageUnit?: string;
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

type StorageUnitInput = { unitType: string; qtyInBaseUom: string; isPreferred: boolean };
type BarcodeInput = { barcode: string; type: string };

// Mirrors the restricted lists in backend/src/skus/skus.service.ts — keep in sync.
const BASE_UOM_OPTIONS = ['PIECE', 'PACK', 'CASE', 'PALLET', 'BOX'];
const STORAGE_CONDITION_OPTIONS = ['AMBIENT', 'CHILLED', 'FROZEN', 'NA'];
const WEIGHT_UOM_OPTIONS = ['KG', 'G', 'LB', 'TONNES'];
const ABC_OPTIONS = ['A', 'B', 'C'];
const STORAGE_UNIT_TYPE_OPTIONS = ['EACH', 'INNER', 'CASE', 'PALLET'];
const BARCODE_TYPE_OPTIONS = ['EACH', 'CASE', 'OTHER'];

const emptyStorageUnit: StorageUnitInput = { unitType: '', qtyInBaseUom: '', isPreferred: false };
const emptyBarcode: BarcodeInput = { barcode: '', type: 'EACH' };

function authHeaders() {
  const token = localStorage.getItem('token');
  return { Authorization: `Bearer ${token}` };
}

function SkusPage() {
  const [skus, setSkus] = useState<Sku[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [search, setSearch] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportSummary | null>(null);
  const [deleteAllResult, setDeleteAllResult] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [subCategory, setSubCategory] = useState('');
  const [primaryStorageUnit, setPrimaryStorageUnit] = useState('');
  const [baseUom, setBaseUom] = useState('');
  const [hsnCode, setHsnCode] = useState('');
  const [storageCondition, setStorageCondition] = useState('AMBIENT');
  const [batchTracked, setBatchTracked] = useState(false);
  const [shelfLifeTracked, setShelfLifeTracked] = useState(false);
  const [shelfLifeDays, setShelfLifeDays] = useState('');
  const [weightUom, setWeightUom] = useState('');
  const [grossWeight, setGrossWeight] = useState('');
  const [isHazmat, setIsHazmat] = useState(false);
  const [hazmatClass, setHazmatClass] = useState('');
  const [hasUniqueBarcode, setHasUniqueBarcode] = useState(false);
  const [abcClass, setAbcClass] = useState('');
  const [currency, setCurrency] = useState('');
  const [standardCost, setStandardCost] = useState('');
  const [moq, setMoq] = useState('');
  const [storageUnits, setStorageUnits] = useState<StorageUnitInput[]>([{ ...emptyStorageUnit }]);
  const [barcodes, setBarcodes] = useState<BarcodeInput[]>([]);
  const [formError, setFormError] = useState('');

  const loadSkus = () => {
  fetch('http://localhost:3000/skus', { headers: authHeaders() })
    .then((res) => {
      if (res.status === 401) {
        localStorage.clear();
        window.location.reload();
        return [];
      }
      return res.json();
    })
    .then((data) => setSkus(Array.isArray(data) ? data : []));
};

  const loadSummary = () => {
    fetch('http://localhost:3000/skus/summary', { headers: authHeaders() })
      .then((res) => {
        if (res.status === 401) {
          localStorage.clear();
          window.location.reload();
          return null;
        }
        return res.json();
      })
      .then((data) => data && setSummary(data));
  };

  const loadCategories = () => {
    fetch('http://localhost:3000/product-categories', { headers: authHeaders() })
      .then((res) => {
        if (res.status === 401) {
          localStorage.clear();
          window.location.reload();
          return [];
        }
        return res.json();
      })
      .then((data) => setCategories(Array.isArray(data) ? data : []));
  };

  const refreshAll = () => {
    loadSkus();
    loadSummary();
  };

  useEffect(() => {
    refreshAll();
    loadCategories();
  }, []);

  const updateStorageUnit = (index: number, field: keyof StorageUnitInput, value: any) => {
    const copy = [...storageUnits];
    copy[index] = { ...copy[index], [field]: value };
    setStorageUnits(copy);
  };
  const addStorageUnit = () => setStorageUnits([...storageUnits, { ...emptyStorageUnit }]);
  const removeStorageUnit = (index: number) => setStorageUnits(storageUnits.filter((_, i) => i !== index));

  const updateBarcode = (index: number, field: keyof BarcodeInput, value: string) => {
    const copy = [...barcodes];
    copy[index] = { ...copy[index], [field]: value };
    setBarcodes(copy);
  };
  const addBarcode = () => setBarcodes([...barcodes, { ...emptyBarcode }]);
  const removeBarcode = (index: number) => setBarcodes(barcodes.filter((_, i) => i !== index));

  const resetForm = () => {
    setCode('');
    setDescription('');
    setCategory('');
    setSubCategory('');
    setPrimaryStorageUnit('');
    setBaseUom('');
    setHsnCode('');
    setStorageCondition('AMBIENT');
    setBatchTracked(false);
    setShelfLifeTracked(false);
    setShelfLifeDays('');
    setWeightUom('');
    setGrossWeight('');
    setIsHazmat(false);
    setHazmatClass('');
    setHasUniqueBarcode(false);
    setAbcClass('');
    setCurrency('');
    setStandardCost('');
    setMoq('');
    setStorageUnits([{ ...emptyStorageUnit }]);
    setBarcodes([]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    const validStorageUnits = storageUnits
      .filter((u) => u.unitType && u.qtyInBaseUom)
      .map((u) => ({ unitType: u.unitType, qtyInBaseUom: Number(u.qtyInBaseUom), isPreferred: u.isPreferred }));
    const validBarcodes = barcodes.filter((b) => b.barcode).map((b) => ({ barcode: b.barcode, type: b.type }));

    const res = await fetch('http://localhost:3000/skus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        code,
        description,
        category: category || undefined,
        subCategory: subCategory || undefined,
        primaryStorageUnit: primaryStorageUnit || undefined,
        baseUom,
        hsnCode,
        storageCondition,
        batchTracked,
        shelfLifeTracked,
        shelfLifeDays: shelfLifeDays || undefined,
        weightUom: weightUom || undefined,
        grossWeight: grossWeight || undefined,
        isHazmat,
        hazmatClass: hazmatClass || undefined,
        hasUniqueBarcode,
        abcClass: abcClass || undefined,
        currency: currency || undefined,
        standardCost: standardCost || undefined,
        moq: moq || undefined,
        storageUnits: validStorageUnits,
        barcodes: validBarcodes,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setFormError(Array.isArray(data.message) ? data.message.join(' | ') : data.message);
      return;
    }
    resetForm();
    refreshAll();
  };

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
      s.category.name.toLowerCase().includes(search.toLowerCase()),
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
              {importResult.results?.map((r) => (
                <li key={r.row} style={{ color: r.status === 'error' ? 'crimson' : 'green' }}>
                  Row {r.row} ({r.code}): {r.status === 'success' ? 'Imported' : r.errors?.join('; ')}
                </li>
              ))}
            </ul>
          </div>
        )}
        {deleteAllResult && <p style={{ marginTop: 12 }}>{deleteAllResult}</p>}
      </div>

      <div style={{ marginBottom: 24 }}>
        <button type="button" onClick={() => setShowForm(!showForm)}>
          {showForm ? '▾ Hide manual entry' : '▸ Add SKU manually'}
        </button>
      </div>

      {showForm && (
      <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>Add SKU</h3>
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <input placeholder="SKU Code" value={code} onChange={(e) => setCode(e.target.value)} required style={{ width: 140 }} />
            <input placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} required style={{ width: 220 }} />
            <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 140 }}>
              <option value="">Category (Uncategorized)</option>
              {categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
            <input placeholder="Sub Category" value={subCategory} onChange={(e) => setSubCategory(e.target.value)} style={{ width: 140 }} />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <select value={baseUom} onChange={(e) => setBaseUom(e.target.value)} required style={{ width: 140 }}>
              <option value="">Base UOM</option>
              {BASE_UOM_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <input placeholder="HSN Code" value={hsnCode} onChange={(e) => setHsnCode(e.target.value)} required style={{ width: 120 }} />
            <select value={storageCondition} onChange={(e) => setStorageCondition(e.target.value)} style={{ width: 140 }}>
              {STORAGE_CONDITION_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <select value={abcClass} onChange={(e) => setAbcClass(e.target.value)} style={{ width: 120 }}>
              <option value="">ABC Class</option>
              {ABC_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 12 }}>
            <label style={{ fontSize: 14 }}>
              <input type="checkbox" checked={batchTracked} onChange={(e) => setBatchTracked(e.target.checked)} /> Batch Tracked
            </label>
            <label style={{ fontSize: 14 }}>
              <input type="checkbox" checked={shelfLifeTracked} onChange={(e) => setShelfLifeTracked(e.target.checked)} /> Shelf-Life Tracked
            </label>
            {shelfLifeTracked && (
              <input placeholder="Shelf Life Days" value={shelfLifeDays} onChange={(e) => setShelfLifeDays(e.target.value)} style={{ width: 130 }} />
            )}
            <label style={{ fontSize: 14 }}>
              <input type="checkbox" checked={hasUniqueBarcode} onChange={(e) => setHasUniqueBarcode(e.target.checked)} /> Has Unique Barcode
            </label>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <select value={weightUom} onChange={(e) => setWeightUom(e.target.value)} style={{ width: 110 }}>
              <option value="">Weight UOM</option>
              {WEIGHT_UOM_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <input placeholder="Gross Weight" value={grossWeight} onChange={(e) => setGrossWeight(e.target.value)} style={{ width: 110 }} />
            <input placeholder="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)} style={{ width: 100 }} />
            <input placeholder="Standard Cost" value={standardCost} onChange={(e) => setStandardCost(e.target.value)} style={{ width: 120 }} />
            <input placeholder="MOQ" value={moq} onChange={(e) => setMoq(e.target.value)} style={{ width: 100 }} />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 12, alignItems: 'center' }}>
            <label style={{ fontSize: 14 }}>
              <input type="checkbox" checked={isHazmat} onChange={(e) => setIsHazmat(e.target.checked)} /> Hazmat
            </label>
            {isHazmat && (
              <input placeholder="Hazmat Class" value={hazmatClass} onChange={(e) => setHazmatClass(e.target.value)} style={{ width: 140 }} />
            )}
          </div>

          <h4 style={{ marginBottom: 8 }}>Storage Units</h4>
          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 14 }}>
              Primary Storage Unit (must match one of the unit types below — used later for putaway/picking sizing):
            </label>{' '}
            <select value={primaryStorageUnit} onChange={(e) => setPrimaryStorageUnit(e.target.value)} style={{ width: 130 }}>
              <option value="">None</option>
              {STORAGE_UNIT_TYPE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          {storageUnits.map((u, i) => (
            <div key={i} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <select value={u.unitType} onChange={(e) => updateStorageUnit(i, 'unitType', e.target.value)} style={{ width: 130 }}>
                <option value="">Unit Type</option>
                {STORAGE_UNIT_TYPE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <input placeholder="Qty in Base UOM" value={u.qtyInBaseUom} onChange={(e) => updateStorageUnit(i, 'qtyInBaseUom', e.target.value)} style={{ width: 130 }} />
              <label style={{ fontSize: 13 }}>
                <input type="checkbox" checked={u.isPreferred} onChange={(e) => updateStorageUnit(i, 'isPreferred', e.target.checked)} /> Preferred
              </label>
              {storageUnits.length > 1 && (
                <button type="button" onClick={() => removeStorageUnit(i)} style={{ color: 'crimson' }}>Remove</button>
              )}
            </div>
          ))}
          <button type="button" onClick={addStorageUnit} style={{ marginBottom: 16 }}>+ Add another Storage Unit</button>

          <h4 style={{ marginBottom: 8 }}>Barcodes</h4>
          {barcodes.map((b, i) => (
            <div key={i} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <input placeholder="Barcode" value={b.barcode} onChange={(e) => updateBarcode(i, 'barcode', e.target.value)} style={{ width: 160 }} />
              <select value={b.type} onChange={(e) => updateBarcode(i, 'type', e.target.value)} style={{ width: 110 }}>
                {BARCODE_TYPE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <button type="button" onClick={() => removeBarcode(i)} style={{ color: 'crimson' }}>Remove</button>
            </div>
          ))}
          <button type="button" onClick={addBarcode} style={{ marginBottom: 16 }}>+ Add a Barcode</button>

          {formError && <p style={{ color: 'crimson' }}>{formError}</p>}
          <div>
            <button type="submit">Add SKU</button>
          </div>
        </form>
      </div>
      )}

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
              <td style={{ padding: 8 }}>{sku.category.name}</td>
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
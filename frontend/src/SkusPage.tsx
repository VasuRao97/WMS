import { useEffect, useMemo, useState } from 'react';

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
  abcClass?: string;
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
  const [showList, setShowList] = useState(true);

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
    if (!res.ok) {
      // Without this check, an error response (e.g. 403 — Delete All is
      // COMPANY_ADMIN-only) has no blockedCodes field — reading .length on
      // it threw silently, so the button appeared to do nothing at all.
      setDeleteAllResult(`Delete All failed: ${Array.isArray(data.message) ? data.message.join(' | ') : data.message || 'Unknown error.'}`);
      return;
    }
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

  // ABC × Category matrix — active SKUs only (an inactive SKU isn't a real
  // slotting/putaway concern any more), so this reads deeper than the old
  // flat "By ABC Class" count: which categories actually carry the fast-
  // moving (A) vs slow-moving (C) volume, not just a company-wide total.
  const abcMatrix = useMemo(() => {
    const activeSkus = skus.filter((s) => s.isActive);
    const categoryNames = Array.from(new Set(activeSkus.map((s) => s.category?.name || 'Uncategorized'))).sort();
    const columns = [...ABC_OPTIONS, 'Unclassified'];
    const rows = categoryNames.map((cat) => {
      const counts = columns.map((col) => activeSkus.filter((s) => (s.category?.name || 'Uncategorized') === cat && (s.abcClass || 'Unclassified') === col).length);
      return { category: cat, counts, total: counts.reduce((sum, n) => sum + n, 0) };
    });
    const columnTotals = columns.map((_, i) => rows.reduce((sum, r) => sum + r.counts[i], 0));
    const grandTotal = columnTotals.reduce((sum, n) => sum + n, 0);
    return { columns, rows, columnTotals, grandTotal };
  }, [skus]);

  return (
    <div style={{ maxWidth: 1000, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1>SKU Master</h1>

      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 8 }}>
        <a href="/templates/SKU_Master_Import_Template.xlsx" download>Download Template</a>
        <input type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files ? e.target.files[0] : null)} />
        <button onClick={handleImport} disabled={!file || importing}>
          {importing ? 'Importing...' : 'Import'}
        </button>
        <button onClick={handleExport}>Export to Excel</button>
        <button onClick={handleDeleteAll} style={{ color: 'crimson' }}>Delete All</button>
        <button type="button" onClick={() => setShowForm(!showForm)}>
          {showForm ? '▾ Hide manual entry' : '▸ Add SKU manually'}
        </button>
      </div>

      {(importResult || deleteAllResult) && (
        <div style={{ marginBottom: 24 }}>
          {importResult && (
            <div>
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
          {deleteAllResult && <p style={{ marginTop: importResult ? 12 : 0 }}>{deleteAllResult}</p>}
        </div>
      )}

      {summary && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 24 }}>
          <div style={cardStyle}><strong>{summary.total}</strong><div>Total SKUs</div></div>
          <div style={cardStyle}><strong>{summary.active}</strong><div>Active</div></div>
          <div style={cardStyle}><strong>{summary.inactive}</strong><div>Inactive</div></div>
        </div>
      )}

      {abcMatrix.rows.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ marginBottom: 4 }}>ABC Analysis by Category</h2>
          <p style={{ marginTop: -4, marginBottom: 8, fontSize: 12, color: '#888' }}>
            Active SKUs only, by Category and ABC Class — which categories actually carry the fast-moving (A) volume.
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'center', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>Category</th>
                {abcMatrix.columns.map((col) => (
                  <th key={col} style={{ textAlign: 'center', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>{col}</th>
                ))}
                <th style={{ textAlign: 'center', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {abcMatrix.rows.map((r) => (
                <tr key={r.category}>
                  <td style={{ textAlign: 'center', padding: '4px 8px' }}>{r.category}</td>
                  {r.counts.map((n, i) => (
                    <td key={abcMatrix.columns[i]} style={{ textAlign: 'center', padding: '4px 8px' }}>{n}</td>
                  ))}
                  <td style={{ textAlign: 'center', padding: '4px 8px' }}><strong>{r.total}</strong></td>
                </tr>
              ))}
              <tr style={{ borderTop: '2px solid #ccc' }}>
                <td style={{ textAlign: 'center', padding: '4px 8px' }}><strong>Total</strong></td>
                {abcMatrix.columnTotals.map((n, i) => (
                  <td key={abcMatrix.columns[i]} style={{ textAlign: 'center', padding: '4px 8px' }}><strong>{n}</strong></td>
                ))}
                <td style={{ textAlign: 'center', padding: '4px 8px' }}><strong>{abcMatrix.grandTotal}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
      <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>Add SKU</h3>
        <p style={{ marginTop: -4, marginBottom: 12, fontSize: 12, color: '#888' }}>* required</p>
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <input placeholder="SKU Code *" value={code} onChange={(e) => setCode(e.target.value)} required style={{ width: 140 }} />
            <input placeholder="Description *" value={description} onChange={(e) => setDescription(e.target.value)} required style={{ width: 220 }} />
            <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 140 }}>
              <option value="">Category (Uncategorized)</option>
              {categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
            <input placeholder="Sub Category" value={subCategory} onChange={(e) => setSubCategory(e.target.value)} style={{ width: 140 }} />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <select value={baseUom} onChange={(e) => setBaseUom(e.target.value)} required style={{ width: 140 }}>
              <option value="">Base UOM *</option>
              {BASE_UOM_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <input placeholder="HSN Code *" value={hsnCode} onChange={(e) => setHsnCode(e.target.value)} required style={{ width: 120 }} />
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
              <input placeholder="Shelf Life Days *" value={shelfLifeDays} onChange={(e) => setShelfLifeDays(e.target.value)} style={{ width: 130 }} />
            )}
            <label style={{ fontSize: 14 }}>
              <input type="checkbox" checked={hasUniqueBarcode} onChange={(e) => setHasUniqueBarcode(e.target.checked)} /> Has Unique Barcode
            </label>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
            <select value={weightUom} onChange={(e) => setWeightUom(e.target.value)} style={{ width: 110 }}>
              <option value="">Weight UOM</option>
              {WEIGHT_UOM_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <input placeholder="Gross Weight" value={grossWeight} onChange={(e) => setGrossWeight(e.target.value)} style={{ width: 110 }} />
            <input placeholder="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)} style={{ width: 100 }} />
            <input placeholder="Standard Cost" value={standardCost} onChange={(e) => setStandardCost(e.target.value)} style={{ width: 120 }} />
            <input placeholder="MOQ" value={moq} onChange={(e) => setMoq(e.target.value)} style={{ width: 100 }} />
          </div>
          <p style={{ marginTop: 0, marginBottom: 12, fontSize: 12, color: '#888' }}>* Weight UOM is required if Gross Weight is given.</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 12, alignItems: 'center' }}>
            <label style={{ fontSize: 14 }}>
              <input type="checkbox" checked={isHazmat} onChange={(e) => setIsHazmat(e.target.checked)} /> Hazmat
            </label>
            {isHazmat && (
              <input placeholder="Hazmat Class *" value={hazmatClass} onChange={(e) => setHazmatClass(e.target.value)} style={{ width: 140 }} />
            )}
          </div>

          <h4 style={{ marginBottom: 4 }}>Storage Units</h4>
          <p style={{ marginTop: 0, marginBottom: 8, fontSize: 12, color: '#888' }}>* At least one Storage Unit is required.</p>
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
                <option value="">Unit Type *</option>
                {STORAGE_UNIT_TYPE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <input placeholder="Qty in Base UOM *" value={u.qtyInBaseUom} onChange={(e) => updateStorageUnit(i, 'qtyInBaseUom', e.target.value)} style={{ width: 130 }} />
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

      <h2 style={{ marginBottom: 8, cursor: 'pointer', userSelect: 'none' }} onClick={() => setShowList(!showList)}>
        {showList ? '▾' : '▸'} List of SKUs
      </h2>

      {showList && (
        <>
          <input
            placeholder="Search by code, description, or category..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: '100%', padding: 8, marginBottom: 16, boxSizing: 'border-box' }}
          />

          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'center', borderBottom: '2px solid #ccc' }}>
                <th style={{ padding: 8 }}>Code</th>
                <th style={{ padding: 8 }}>Description</th>
                <th style={{ padding: 8 }}>Category</th>
                <th style={{ padding: 8 }}>Storage Units</th>
                <th style={{ padding: 8 }}>Status</th>
                <th style={{ padding: 8 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((sku) => (
                <tr key={sku.id} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: 8, fontWeight: 'bold' }}>{sku.code}</td>
                  <td style={{ padding: 8 }}>{sku.description}</td>
                  <td style={{ padding: 8 }}>{sku.category.name}</td>
                  <td style={{ padding: 8 }}>
                    {sku.storageUnits.map((u) => `${u.unitType}=${u.qtyInBaseUom}${u.isPreferred ? ' *' : ''}`).join(', ')}
                  </td>
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
        </>
      )}
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
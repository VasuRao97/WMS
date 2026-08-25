import { Fragment, useEffect, useState } from 'react';

type StorageType = {
  id: string;
  storageType: string;
  palletPositions: number;
  category?: { id: string; name: string };
  lengthM?: number;
  widthM?: number;
  heightM?: number;
};
type DispatchFlow = { id: string; flowType: string };
type ProductCategory = { id: string; name: string };

type Warehouse = {
  id: string;
  code: string;
  name: string;
  address?: string;
  nodeType?: string;
  city?: string;
  pincode?: string;
  latitude?: number;
  longitude?: number;
  threePlName?: string;
  noOfDocks?: number;
  areaSqFt?: number;
  isActive: boolean;
  storageTypes: StorageType[];
  dispatchFlows: DispatchFlow[];
};

type WarehouseCustomerSummary = {
  warehouseId: string;
  code: string;
  name: string;
  shipToCount: number;
  customerCount: number;
  localCount: number;
  upcountryCount: number;
};

// Planned Pallet Positions (from the Storage Type breakdown below) vs how
// many actually exist among generated Locations — a "did we forget to
// generate something" cross-check, not the reverse (a Location that
// doesn't match any planned row isn't flagged as extra). See
// WarehousesService.getMappingSummary for the full reasoning.
type MappingRow = { storageType: string; category: string; planned: number; mapped: number };
type WarehouseMappingSummary = { warehouseId: string; code: string; name: string; rows: MappingRow[]; totalPlanned: number; totalMapped: number };

type StorageTypeInput = {
  storageType: string;
  palletPositions: string;
  category: string;
  lengthM: string;
  widthM: string;
  heightM: string;
};

type ImportResultRow = { code: string; status: 'success' | 'error'; errors?: string[]; storageTypeCount?: number; dispatchFlowCount?: number };
type ImportSummary = { totalWarehouses: number; successCount: number; failCount: number; results: ImportResultRow[] };

const NODE_TYPE_OPTIONS = [
  { value: 'FACTORY', label: 'Factory' },
  { value: 'DISTRIBUTOR', label: 'Distributor' },
  { value: 'REGIONAL_DC', label: 'Regional DC' },
  { value: 'NATIONAL_DC', label: 'National DC' },
  { value: 'CNF', label: 'CNF' },
  { value: 'CROSS_DOCK', label: 'Cross-dock' },
];

const STORAGE_TYPE_OPTIONS = [
  { value: 'GROUND_FLOOR', label: 'Ground/Floor' },
  { value: 'SPR', label: 'SPR' },
  { value: 'DRIVE_IN', label: 'Drive-in' },
  { value: 'MIX', label: 'Mix' },
  { value: 'ASRS', label: 'ASRS' },
];

const DISPATCH_FLOW_OPTIONS = [
  { value: 'FULL_PALLET', label: 'Full Pallet' },
  { value: 'CASE_PICK', label: 'Case Pick' },
  { value: 'BROKEN_CASE', label: 'Broken Case' },
];

function labelFor(options: { value: string; label: string }[], value?: string) {
  return options.find((o) => o.value === value)?.label || value || '—';
}

function authHeaders() {
  const token = localStorage.getItem('token');
  return { Authorization: `Bearer ${token}` };
}

const emptyStorageType: StorageTypeInput = { storageType: '', palletPositions: '', category: '', lengthM: '', widthM: '', heightM: '' };

function WarehousesPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [customerSummary, setCustomerSummary] = useState<WarehouseCustomerSummary[]>([]);
  const [mappingSummary, setMappingSummary] = useState<WarehouseMappingSummary[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportSummary | null>(null);
  const [deleteAllResult, setDeleteAllResult] = useState<string | null>(null);

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [nodeType, setNodeType] = useState('');
  const [city, setCity] = useState('');
  const [address, setAddress] = useState('');
  const [pincode, setPincode] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [threePlName, setThreePlName] = useState('');
  const [noOfDocks, setNoOfDocks] = useState('');
  const [areaSqFt, setAreaSqFt] = useState('');
  const [gstin, setGstin] = useState('');
  const [workingDays, setWorkingDays] = useState('');
  const [workingHours, setWorkingHours] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [storageTypes, setStorageTypes] = useState<StorageTypeInput[]>([{ ...emptyStorageType }]);
  const [dispatchFlows, setDispatchFlows] = useState<string[]>([]);
  const [formError, setFormError] = useState('');
  const [showForm, setShowForm] = useState(false);

  const loadWarehouses = () => {
    fetch('http://localhost:3000/warehouses', { headers: authHeaders() })
      .then((res) => {
        if (res.status === 401) {
          localStorage.clear();
          window.location.reload();
          return [];
        }
        return res.json();
      })
      .then((data) => setWarehouses(Array.isArray(data) ? data : []));
  };

  const loadCustomerSummary = () => {
    fetch('http://localhost:3000/warehouses/customer-summary', { headers: authHeaders() })
      .then((res) => {
        if (res.status === 401) {
          localStorage.clear();
          window.location.reload();
          return [];
        }
        return res.json();
      })
      .then((data) => setCustomerSummary(Array.isArray(data) ? data : []));
  };

  const loadMappingSummary = () => {
    fetch('http://localhost:3000/warehouses/mapping-summary', { headers: authHeaders() })
      .then((res) => (res.status === 401 ? [] : res.json()))
      .then((data) => setMappingSummary(Array.isArray(data) ? data : []));
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
    loadWarehouses();
    loadCustomerSummary();
    loadMappingSummary();
  };

  useEffect(() => {
    refreshAll();
    loadCategories();
  }, []);

  const updateStorageType = (index: number, field: keyof StorageTypeInput, value: string) => {
    const copy = [...storageTypes];
    copy[index] = { ...copy[index], [field]: value };
    setStorageTypes(copy);
  };
  const addStorageType = () => setStorageTypes([...storageTypes, { ...emptyStorageType }]);
  const removeStorageType = (index: number) => setStorageTypes(storageTypes.filter((_, i) => i !== index));

  const toggleDispatchFlow = (value: string) => {
    setDispatchFlows((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  };

  const resetForm = () => {
    setCode('');
    setName('');
    setNodeType('');
    setCity('');
    setAddress('');
    setPincode('');
    setLatitude('');
    setLongitude('');
    setThreePlName('');
    setNoOfDocks('');
    setAreaSqFt('');
    setGstin('');
    setWorkingDays('');
    setWorkingHours('');
    setContactName('');
    setContactPhone('');
    setStorageTypes([{ ...emptyStorageType }]);
    setDispatchFlows([]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    const validStorageTypes = storageTypes
      .filter((s) => s.storageType && s.palletPositions)
      .map((s) => ({
        storageType: s.storageType,
        palletPositions: Number(s.palletPositions),
        category: s.category || undefined,
        lengthM: s.lengthM || undefined,
        widthM: s.widthM || undefined,
        heightM: s.heightM || undefined,
      }));

    const res = await fetch('http://localhost:3000/warehouses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        code,
        name,
        nodeType,
        city,
        address,
        pincode,
        latitude: latitude || undefined,
        longitude: longitude || undefined,
        threePlName: threePlName || undefined,
        noOfDocks: noOfDocks || undefined,
        areaSqFt: areaSqFt || undefined,
        gstin: gstin || undefined,
        workingDays: workingDays || undefined,
        workingHours: workingHours || undefined,
        contactName: contactName || undefined,
        contactPhone: contactPhone || undefined,
        storageTypes: validStorageTypes.length ? validStorageTypes : undefined,
        dispatchFlows: dispatchFlows.length ? dispatchFlows.map((flowType) => ({ flowType })) : undefined,
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
    const res = await fetch('http://localhost:3000/warehouses/import', { method: 'POST', headers: authHeaders(), body: formData });
    const data = await res.json();
    setImportResult(data);
    setImporting(false);
    setFile(null);
    refreshAll();
  };

  const handleExport = () => {
    fetch('http://localhost:3000/warehouses/export', { headers: authHeaders() })
      .then((res) => res.blob())
      .then((blob) => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'Warehouse_Master_Export.xlsx';
        a.click();
        window.URL.revokeObjectURL(url);
      });
  };

  const handleDeactivate = async (id: string, isActive: boolean) => {
    const action = isActive ? 'deactivate' : 'reactivate';
    await fetch(`http://localhost:3000/warehouses/${id}/${action}`, { method: 'PATCH', headers: authHeaders() });
    refreshAll();
  };

  const handleDelete = async (id: string, code: string) => {
    if (!confirm(`Permanently delete ${code}? This cannot be undone.`)) return;
    const res = await fetch(`http://localhost:3000/warehouses/${id}`, { method: 'DELETE', headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) {
      alert(data.message || 'Could not delete this warehouse.');
      return;
    }
    refreshAll();
  };

  const handleDeleteAll = async () => {
    if (!confirm('Permanently delete ALL warehouses that have no linked data (customers, locations, transactions)? This cannot be undone.')) return;
    const res = await fetch('http://localhost:3000/warehouses/all', { method: 'DELETE', headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) {
      // Without this check, an error response (e.g. 403 — Delete All is
      // COMPANY_ADMIN-only) has no blockedCodes field — reading .length on
      // it threw silently, so the button appeared to do nothing at all.
      setDeleteAllResult(`Delete All failed: ${Array.isArray(data.message) ? data.message.join(' | ') : data.message || 'Unknown error.'}`);
      return;
    }
    setDeleteAllResult(
      `Deleted ${data.deletedCount} warehouse(s). ${data.blockedCount} blocked (have linked data)${data.blockedCodes.length ? ': ' + data.blockedCodes.join(', ') : ''}.`,
    );
    refreshAll();
  };

  return (
    <div style={{ maxWidth: 1100, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1>Warehouse Master</h1>

      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 8 }}>
        <a href="/templates/Warehouse_Master_Import_Template.xlsx" download>Download Template</a>
        <input type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files ? e.target.files[0] : null)} />
        <button onClick={handleImport} disabled={!file || importing}>
          {importing ? 'Importing...' : 'Import'}
        </button>
        <button onClick={handleExport}>Export to Excel</button>
        <button onClick={handleDeleteAll} style={{ color: 'crimson' }}>Delete All</button>
        <button type="button" onClick={() => setShowForm(!showForm)}>
          {showForm ? '▾ Hide manual entry' : '▸ Add Warehouse manually'}
        </button>
      </div>

      {(importResult || deleteAllResult) && (
        <div style={{ marginBottom: 24 }}>
          {importResult && (
            <div>
              <p><strong>{importResult.successCount}</strong> succeeded, <strong>{importResult.failCount}</strong> failed, out of {importResult.totalWarehouses} warehouses.</p>
              <ul style={{ maxHeight: 200, overflowY: 'auto' }}>
                {importResult.results?.map((r, i) => (
                  <li key={i} style={{ color: r.status === 'error' ? 'crimson' : 'green' }}>
                    {r.code}: {r.status === 'success' ? `Imported (${r.storageTypeCount} storage entr${r.storageTypeCount === 1 ? 'y' : 'ies'}, ${r.dispatchFlowCount} dispatch flow(s))` : r.errors?.join('; ')}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {deleteAllResult && <p style={{ marginTop: importResult ? 12 : 0 }}>{deleteAllResult}</p>}
        </div>
      )}

      {showForm && (
      <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>Add Warehouse</h3>
        <p style={{ marginTop: -4, marginBottom: 12, fontSize: 12, color: '#888' }}>* required</p>
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <select value={nodeType} onChange={(e) => setNodeType(e.target.value)} required style={{ width: 150 }}>
              <option value="">Type of Node *</option>
              {NODE_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <input placeholder="Location Code (e.g. TN01) *" value={code} onChange={(e) => setCode(e.target.value)} required style={{ width: 160 }} />
            <input placeholder="Name *" value={name} onChange={(e) => setName(e.target.value)} required style={{ width: 180 }} />
            <input placeholder="City *" value={city} onChange={(e) => setCity(e.target.value)} required style={{ width: 130 }} />
            <input placeholder="Address *" value={address} onChange={(e) => setAddress(e.target.value)} required style={{ width: 200 }} />
            <input placeholder="Pincode *" value={pincode} onChange={(e) => setPincode(e.target.value)} required style={{ width: 100 }} />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <input placeholder="Latitude" value={latitude} onChange={(e) => setLatitude(e.target.value)} style={{ width: 110 }} />
            <input placeholder="Longitude" value={longitude} onChange={(e) => setLongitude(e.target.value)} style={{ width: 110 }} />
            <input placeholder="3PL Name (or OWN)" value={threePlName} onChange={(e) => setThreePlName(e.target.value)} style={{ width: 160 }} />
            <input placeholder="No of Docks" value={noOfDocks} onChange={(e) => setNoOfDocks(e.target.value)} style={{ width: 110 }} />
            <input placeholder="Area sq ft" value={areaSqFt} onChange={(e) => setAreaSqFt(e.target.value)} style={{ width: 110 }} />
            <input placeholder="GSTIN" value={gstin} onChange={(e) => setGstin(e.target.value)} style={{ width: 150 }} />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <input placeholder="Working Days (e.g. Mon-Sat)" value={workingDays} onChange={(e) => setWorkingDays(e.target.value)} style={{ width: 170 }} />
            <input placeholder="Working Hours (e.g. 09:00-18:00)" value={workingHours} onChange={(e) => setWorkingHours(e.target.value)} style={{ width: 190 }} />
            <input placeholder="Contact Name" value={contactName} onChange={(e) => setContactName(e.target.value)} style={{ width: 150 }} />
            <input placeholder="Contact Phone" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} style={{ width: 140 }} />
          </div>

          <h4 style={{ marginBottom: 8 }}>Storage Types</h4>
          <p style={{ marginTop: -4, marginBottom: 8, fontSize: 13, color: '#666' }}>
            One row per Storage Type + Category combination — the same Category can appear against more than one Storage Type
            (e.g. Car Tyres split across SPR and Ground/Floor), each with its own Pallet count and dimensions.
            <br />* Pallet Positions is required once you pick a Storage Type on a row.
          </p>
          {storageTypes.map((s, i) => (
            <div key={i} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <select value={s.storageType} onChange={(e) => updateStorageType(i, 'storageType', e.target.value)} style={{ width: 150 }}>
                <option value="">Storage Type</option>
                {STORAGE_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <select value={s.category} onChange={(e) => updateStorageType(i, 'category', e.target.value)} style={{ width: 150 }}>
                <option value="">Category (Uncategorized)</option>
                {categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
              <input placeholder="Pallet Positions *" value={s.palletPositions} onChange={(e) => updateStorageType(i, 'palletPositions', e.target.value)} style={{ width: 130 }} />
              <input placeholder="Dim L (m)" value={s.lengthM} onChange={(e) => updateStorageType(i, 'lengthM', e.target.value)} style={{ width: 90 }} />
              <input placeholder="Dim W (m)" value={s.widthM} onChange={(e) => updateStorageType(i, 'widthM', e.target.value)} style={{ width: 90 }} />
              <input placeholder="Dim H (m)" value={s.heightM} onChange={(e) => updateStorageType(i, 'heightM', e.target.value)} style={{ width: 90 }} />
              {storageTypes.length > 1 && (
                <button type="button" onClick={() => removeStorageType(i)} style={{ color: 'crimson' }}>Remove</button>
              )}
            </div>
          ))}
          <button type="button" onClick={addStorageType} style={{ marginBottom: 16 }}>+ Add another Storage Type</button>

          <h4 style={{ marginBottom: 8 }}>Dispatch Flows</h4>
          <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
            {DISPATCH_FLOW_OPTIONS.map((o) => (
              <label key={o.value} style={{ fontSize: 14 }}>
                <input type="checkbox" checked={dispatchFlows.includes(o.value)} onChange={() => toggleDispatchFlow(o.value)} /> {o.label}
              </label>
            ))}
          </div>

          {formError && <p style={{ color: 'crimson' }}>{formError}</p>}
          <div>
            <button type="submit">Add Warehouse</button>
          </div>
        </form>
      </div>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 32 }}>
        <thead>
          <tr style={{ textAlign: 'center', borderBottom: '2px solid #ccc' }}>
            <th style={{ padding: 8 }}>Code</th>
            <th style={{ padding: 8 }}>Node Type</th>
            <th style={{ padding: 8 }}>City</th>
            <th style={{ padding: 8 }}>3PL Name</th>
            <th style={{ padding: 8 }}>Storage</th>
            <th style={{ padding: 8 }}>Dispatch Flows</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {warehouses.map((w) => (
            <tr key={w.id} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
              <td style={{ padding: 8, fontWeight: 'bold' }}>{w.code}</td>
              <td style={{ padding: 8 }}>{labelFor(NODE_TYPE_OPTIONS, w.nodeType)}</td>
              <td style={{ padding: 8 }}>{w.city || '—'}</td>
              <td style={{ padding: 8 }}>{w.threePlName || '—'}</td>
              <td style={{ padding: 8 }}>
                {w.storageTypes.length
                  ? w.storageTypes.map((s) => `${labelFor(STORAGE_TYPE_OPTIONS, s.storageType)}=${s.palletPositions}`).join(', ')
                  : '—'}
              </td>
              <td style={{ padding: 8 }}>
                {w.dispatchFlows.length ? w.dispatchFlows.map((f) => labelFor(DISPATCH_FLOW_OPTIONS, f.flowType)).join(', ') : '—'}
              </td>
              <td style={{ padding: 8 }}>{w.isActive ? 'Active' : 'Inactive'}</td>
              <td style={{ padding: 8, whiteSpace: 'nowrap' }}>
                <button onClick={() => handleDeactivate(w.id, w.isActive)}>
                  {w.isActive ? 'Deactivate' : 'Reactivate'}
                </button>
                <button onClick={() => handleDelete(w.id, w.code)} style={{ marginLeft: 6, color: 'crimson' }}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {warehouses.length === 0 && <p style={{ marginTop: 16 }}>No warehouses found.</p>}

      <h2 style={{ marginTop: 32 }}>Local / Upc Split Analysis</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'center', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>Warehouse</th>
            <th style={{ textAlign: 'center', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>Local</th>
            <th style={{ textAlign: 'center', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>Upcountry</th>
          </tr>
        </thead>
        <tbody>
          {customerSummary.map((s) => (
            <tr key={s.warehouseId}>
              <td style={{ textAlign: 'center', padding: '4px 8px' }}>
                <strong>{s.code}</strong> — {s.name}
              </td>
              <td style={{ textAlign: 'center', padding: '4px 8px' }}>{s.localCount}</td>
              <td style={{ textAlign: 'center', padding: '4px 8px' }}>{s.upcountryCount}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginTop: 32 }}>Storage Type Mapping</h2>
      <p style={{ marginTop: -4, marginBottom: 8, fontSize: 12, color: '#888' }}>
        Cross-checks planned Pallet Positions against how many actually exist among generated Locations.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 32 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'center', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>Warehouse</th>
            <th style={{ textAlign: 'center', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>Storage Type</th>
            <th style={{ textAlign: 'center', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>Category</th>
            <th style={{ textAlign: 'center', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>Planned</th>
            <th style={{ textAlign: 'center', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>Mapped</th>
          </tr>
        </thead>
        <tbody>
          {mappingSummary
            .filter((s) => s.rows.length > 0)
            .map((s) => (
              <Fragment key={s.warehouseId}>
                {s.rows.map((r, i) => (
                  <tr key={`${s.warehouseId}-${i}`}>
                    <td style={{ textAlign: 'center', padding: '4px 8px' }}>{i === 0 ? <><strong>{s.code}</strong> — {s.name}</> : ''}</td>
                    <td style={{ textAlign: 'center', padding: '4px 8px' }}>{labelFor(STORAGE_TYPE_OPTIONS, r.storageType)}</td>
                    <td style={{ textAlign: 'center', padding: '4px 8px' }}>{r.category}</td>
                    <td style={{ textAlign: 'center', padding: '4px 8px' }}>{r.planned}</td>
                    <td style={{ textAlign: 'center', padding: '4px 8px', color: r.mapped >= r.planned ? '#1a7f37' : 'crimson', fontWeight: r.mapped < r.planned ? 'bold' : 'normal' }}>
                      {r.mapped}
                    </td>
                  </tr>
                ))}
                <tr key={`${s.warehouseId}-total`} style={{ borderBottom: '2px solid #ccc' }}>
                  <td style={{ textAlign: 'center', padding: '4px 8px' }} />
                  <td style={{ textAlign: 'center', padding: '4px 8px' }} colSpan={2}>
                    <strong>Total</strong>
                  </td>
                  <td style={{ textAlign: 'center', padding: '4px 8px' }}>
                    <strong>{s.totalPlanned}</strong>
                  </td>
                  <td style={{ textAlign: 'center', padding: '4px 8px', color: s.totalMapped >= s.totalPlanned ? '#1a7f37' : 'crimson' }}>
                    <strong>{s.totalMapped}</strong>
                  </td>
                </tr>
              </Fragment>
            ))}
        </tbody>
      </table>
      {mappingSummary.filter((s) => s.rows.length > 0).length === 0 && (
        <p style={{ marginTop: -20, marginBottom: 32 }}>No Storage Type breakdown data to cross-check yet.</p>
      )}
    </div>
  );
}

export default WarehousesPage;

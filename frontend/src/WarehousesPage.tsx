import { useEffect, useState } from 'react';

type StorageType = { id: string; storageType: string; palletPositions: number };
type DispatchFlow = { id: string; flowType: string };

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

type StorageTypeInput = { storageType: string; palletPositions: string };

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

const emptyStorageType: StorageTypeInput = { storageType: '', palletPositions: '' };

function WarehousesPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [customerSummary, setCustomerSummary] = useState<WarehouseCustomerSummary[]>([]);
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
  const [storageTypes, setStorageTypes] = useState<StorageTypeInput[]>([{ ...emptyStorageType }]);
  const [dispatchFlows, setDispatchFlows] = useState<string[]>([]);
  const [formError, setFormError] = useState('');

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

  const refreshAll = () => {
    loadWarehouses();
    loadCustomerSummary();
  };

  useEffect(() => {
    refreshAll();
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
    setStorageTypes([{ ...emptyStorageType }]);
    setDispatchFlows([]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    const validStorageTypes = storageTypes
      .filter((s) => s.storageType && s.palletPositions)
      .map((s) => ({ storageType: s.storageType, palletPositions: Number(s.palletPositions) }));

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

  const handleDeactivate = async (id: string, isActive: boolean) => {
    const action = isActive ? 'deactivate' : 'reactivate';
    await fetch(`http://localhost:3000/warehouses/${id}/${action}`, { method: 'PATCH', headers: authHeaders() });
    refreshAll();
  };

  const handleDeleteAll = async () => {
    if (!confirm('Permanently delete ALL warehouses that have no linked data (customers, locations, transactions)? This cannot be undone.')) return;
    const res = await fetch('http://localhost:3000/warehouses/all', { method: 'DELETE', headers: authHeaders() });
    const data = await res.json();
    setDeleteAllResult(
      `Deleted ${data.deletedCount} warehouse(s). ${data.blockedCount} blocked (have linked data)${data.blockedCodes.length ? ': ' + data.blockedCodes.join(', ') : ''}.`,
    );
    refreshAll();
  };

  return (
    <div style={{ maxWidth: 1100, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1>Warehouses</h1>

      <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>Import from Excel</h3>
        <input type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files ? e.target.files[0] : null)} />
        <button onClick={handleImport} disabled={!file || importing} style={{ marginLeft: 8 }}>
          {importing ? 'Importing...' : 'Import'}
        </button>
        <button onClick={handleDeleteAll} style={{ marginLeft: 8, color: 'crimson' }}>Delete All</button>

        {importResult && (
          <div style={{ marginTop: 16 }}>
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
        {deleteAllResult && <p style={{ marginTop: 12 }}>{deleteAllResult}</p>}
      </div>

      <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>Add Warehouse</h3>
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <select value={nodeType} onChange={(e) => setNodeType(e.target.value)} required style={{ width: 150 }}>
              <option value="">Type of Node</option>
              {NODE_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <input placeholder="Location Code (e.g. TN01)" value={code} onChange={(e) => setCode(e.target.value)} required style={{ width: 150 }} />
            <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required style={{ width: 180 }} />
            <input placeholder="City" value={city} onChange={(e) => setCity(e.target.value)} required style={{ width: 130 }} />
            <input placeholder="Address" value={address} onChange={(e) => setAddress(e.target.value)} required style={{ width: 200 }} />
            <input placeholder="Pincode" value={pincode} onChange={(e) => setPincode(e.target.value)} required style={{ width: 100 }} />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <input placeholder="Latitude" value={latitude} onChange={(e) => setLatitude(e.target.value)} style={{ width: 110 }} />
            <input placeholder="Longitude" value={longitude} onChange={(e) => setLongitude(e.target.value)} style={{ width: 110 }} />
            <input placeholder="3PL Name (or OWN)" value={threePlName} onChange={(e) => setThreePlName(e.target.value)} style={{ width: 160 }} />
            <input placeholder="No of Docks" value={noOfDocks} onChange={(e) => setNoOfDocks(e.target.value)} style={{ width: 110 }} />
            <input placeholder="Area sq ft" value={areaSqFt} onChange={(e) => setAreaSqFt(e.target.value)} style={{ width: 110 }} />
          </div>

          <h4 style={{ marginBottom: 8 }}>Storage Types</h4>
          {storageTypes.map((s, i) => (
            <div key={i} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <select value={s.storageType} onChange={(e) => updateStorageType(i, 'storageType', e.target.value)} style={{ width: 150 }}>
                <option value="">Storage Type</option>
                {STORAGE_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <input placeholder="Pallet Positions" value={s.palletPositions} onChange={(e) => updateStorageType(i, 'palletPositions', e.target.value)} style={{ width: 130 }} />
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

      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 32 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #ccc' }}>
            <th style={{ padding: 8 }}>Code</th>
            <th style={{ padding: 8 }}>Name</th>
            <th style={{ padding: 8 }}>Type of Node</th>
            <th style={{ padding: 8 }}>City</th>
            <th style={{ padding: 8 }}>Docks</th>
            <th style={{ padding: 8 }}>Storage</th>
            <th style={{ padding: 8 }}>Dispatch Flows</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {warehouses.map((w) => (
            <tr key={w.id} style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: 8, fontWeight: 'bold' }}>{w.code}</td>
              <td style={{ padding: 8 }}>{w.name}</td>
              <td style={{ padding: 8 }}>{labelFor(NODE_TYPE_OPTIONS, w.nodeType)}</td>
              <td style={{ padding: 8 }}>{w.city || '—'}</td>
              <td style={{ padding: 8 }}>{w.noOfDocks ?? '—'}</td>
              <td style={{ padding: 8 }}>
                {w.storageTypes.length ? w.storageTypes.map((s) => `${labelFor(STORAGE_TYPE_OPTIONS, s.storageType)}=${s.palletPositions}`).join(', ') : '—'}
              </td>
              <td style={{ padding: 8 }}>
                {w.dispatchFlows.length ? w.dispatchFlows.map((f) => labelFor(DISPATCH_FLOW_OPTIONS, f.flowType)).join(', ') : '—'}
              </td>
              <td style={{ padding: 8 }}>{w.isActive ? 'Active' : 'Inactive'}</td>
              <td style={{ padding: 8, whiteSpace: 'nowrap' }}>
                <button onClick={() => handleDeactivate(w.id, w.isActive)}>
                  {w.isActive ? 'Deactivate' : 'Reactivate'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {warehouses.length === 0 && <p style={{ marginTop: 16 }}>No warehouses found.</p>}

      <h2 style={{ marginTop: 32 }}>Customers per Warehouse</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>Warehouse</th>
            <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>Customers</th>
            <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>Ship-To Locations</th>
            <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>Local</th>
            <th style={{ textAlign: 'right', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>Upcountry</th>
          </tr>
        </thead>
        <tbody>
          {customerSummary.map((s) => (
            <tr key={s.warehouseId}>
              <td style={{ padding: '4px 8px' }}>
                <strong>{s.code}</strong> — {s.name}
              </td>
              <td style={{ textAlign: 'right', padding: '4px 8px' }}>{s.customerCount}</td>
              <td style={{ textAlign: 'right', padding: '4px 8px' }}>{s.shipToCount}</td>
              <td style={{ textAlign: 'right', padding: '4px 8px' }}>{s.localCount}</td>
              <td style={{ textAlign: 'right', padding: '4px 8px' }}>{s.upcountryCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default WarehousesPage;

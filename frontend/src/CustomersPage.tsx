import { Fragment, useEffect, useState } from 'react';

type Warehouse = { code: string; name: string } | null;

type ShipTo = {
  id: string;
  shipToCode?: string;
  address: string;
  pincode: string;
  state: string;
  gstNumber?: string;
  isDefault: boolean;
  warehouse: Warehouse;
  deliveryZone?: string;
};

type Customer = {
  id: string;
  code: string;
  name: string;
  category?: string;
  email?: string;
  pan?: string;
  billingAddress?: string;
  pincode?: string;
  state?: string;
  gstNumber?: string;
  isActive: boolean;
  shipToLocations: ShipTo[];
};

type ShipToInput = {
  shipToCode: string;
  address: string;
  pincode: string;
  state: string;
  gstNumber: string;
  warehouseCode: string;
  isDefault: boolean;
  deliveryZone: string;
};

function authHeaders() {
  const token = localStorage.getItem('token');
  return { Authorization: `Bearer ${token}` };
}

const emptyShipTo: ShipToInput = {
  shipToCode: '',
  address: '',
  pincode: '',
  state: '',
  gstNumber: '',
  warehouseCode: '',
  isDefault: false,
  deliveryZone: '',
};

function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);
  const [deleteAllResult, setDeleteAllResult] = useState<string | null>(null);
  const [showList, setShowList] = useState(true);

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [email, setEmail] = useState('');
  const [pan, setPan] = useState('');
  const [billingAddress, setBillingAddress] = useState('');
  const [pincode, setPincode] = useState('');
  const [state, setState] = useState('');
  const [gstNumber, setGstNumber] = useState('');
  const [shipTos, setShipTos] = useState<ShipToInput[]>([{ ...emptyShipTo }]);
  const [formError, setFormError] = useState('');
  const [showForm, setShowForm] = useState(false);

  const loadCustomers = () => {
  fetch('http://localhost:3000/customers', { headers: authHeaders() })
    .then((res) => {
      if (res.status === 401) {
        localStorage.clear();
        window.location.reload();
        return [];
      }
      return res.json();
    })
    .then((data) => setCustomers(Array.isArray(data) ? data : []));
};

const handleImport = async () => { 
  if (!file) return; setImporting(true); 
  setImportResult(null); 
  const formData = new FormData(); 
  formData.append('file', file); 
  const res = await fetch('http://localhost:3000/customers/import', { method: 'POST', headers: authHeaders(), body: formData, }); 
  const data = await res.json(); 
  setImportResult(data); 
  setImporting(false); 
  setFile(null); 
  loadCustomers(); };

  useEffect(() => {
    loadCustomers();
  }, []);

  const updateShipTo = (index: number, field: keyof ShipToInput, value: any) => {
    const copy = [...shipTos];
    copy[index] = { ...copy[index], [field]: value };
    setShipTos(copy);
  };

  const addShipTo = () => setShipTos([...shipTos, { ...emptyShipTo }]);
  const removeShipTo = (index: number) => setShipTos(shipTos.filter((_, i) => i !== index));

  const resetForm = () => {
    setCode('');
    setName('');
    setCategory('');
    setEmail('');
    setPan('');
    setBillingAddress('');
    setPincode('');
    setState('');
    setGstNumber('');
    setShipTos([{ ...emptyShipTo }]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    const validShipTos = shipTos
      .filter((s) => s.address || s.pincode || s.state)
      .map((s) => ({ ...s, warehouseCode: s.warehouseCode || undefined }));

    const res = await fetch('http://localhost:3000/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        code,
        name,
        category: category || undefined,
        email: email || undefined,
        pan: pan || undefined,
        billingAddress: billingAddress || undefined,
        pincode: pincode || undefined,
        state: state || undefined,
        gstNumber: gstNumber || undefined,
        shipToLocations: validShipTos.length ? validShipTos : undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setFormError(Array.isArray(data.message) ? data.message.join(' | ') : data.message);
      return;
    }
    resetForm();
    loadCustomers();
  };

  const handleExport = () => {
    fetch('http://localhost:3000/customers/export', { headers: authHeaders() })
      .then((res) => res.blob())
      .then((blob) => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'Customer_Master_Export.xlsx';
        a.click();
        window.URL.revokeObjectURL(url);
      });
  };

  const handleDeactivate = async (id: string, isActive: boolean) => {
    const action = isActive ? 'deactivate' : 'reactivate';
    await fetch(`http://localhost:3000/customers/${id}/${action}`, { method: 'PATCH', headers: authHeaders() });
    loadCustomers();
  };

  const handleDelete = async (id: string, code: string) => {
    if (!confirm(`Permanently delete ${code}? This cannot be undone.`)) return;
    await fetch(`http://localhost:3000/customers/${id}`, { method: 'DELETE', headers: authHeaders() });
    loadCustomers();
  };

  const handleDeleteAll = async () => {
    if (!confirm('Permanently delete ALL customers (and their ship-to locations)? This cannot be undone.')) return;
    const res = await fetch('http://localhost:3000/customers/all', { method: 'DELETE', headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) {
      // Without this check, an error response (e.g. 403 — Delete All is
      // COMPANY_ADMIN-only) showed as "Deleted undefined customer(s)."
      // instead of a real error — same silent-failure class as the other
      // three master-data pages' Delete All buttons.
      setDeleteAllResult(`Delete All failed: ${Array.isArray(data.message) ? data.message.join(' | ') : data.message || 'Unknown error.'}`);
      return;
    }
    setDeleteAllResult(`Deleted ${data.deletedCount} customer(s).`);
    loadCustomers();
  };

  const customerStats = {
    total: customers.length,
    active: customers.filter((c) => c.isActive).length,
    inactive: customers.filter((c) => !c.isActive).length,
  };

  const allShipTos = customers.flatMap((c) => c.shipToLocations);
  const localCount = allShipTos.filter((s) => s.deliveryZone === 'LOCAL').length;
  const upcountryCount = allShipTos.filter((s) => s.deliveryZone === 'UPCOUNTRY').length;
  const unclassifiedCount = allShipTos.length - localCount - upcountryCount;

  const filtered = customers.filter(
    (c) =>
      c.code.toLowerCase().includes(search.toLowerCase()) ||
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      (c.category || '').toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div style={{ maxWidth: 1050, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1>Customer Master</h1>

      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 8 }}>
        <a href="/templates/Customer_Master_Import_Template.xlsx" download>Download Template</a>
        <input type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files ? e.target.files[0] : null)} />
        <button onClick={handleImport} disabled={!file || importing}>
          {importing ? 'Importing...' : 'Import'}
        </button>
        <button onClick={handleExport}>Export to Excel</button>
        <button onClick={handleDeleteAll} style={{ color: 'crimson' }}>Delete All</button>
        <button type="button" onClick={() => setShowForm(!showForm)}>
          {showForm ? '▾ Hide manual entry' : '▸ Add Customer manually'}
        </button>
      </div>

      {(importResult || deleteAllResult) && (
        <div style={{ marginBottom: 24 }}>
          {importResult && (
            <div>
              <p>
                <strong>{importResult.successCount}</strong> succeeded, <strong>{importResult.failCount}</strong> failed, out of {importResult.totalCustomers} customers.
              </p>
              <ul style={{ maxHeight: 200, overflowY: 'auto' }}>
                {importResult.results?.map((r: any, i: number) => (
                  <li key={i} style={{ color: r.status === 'error' ? 'crimson' : 'green' }}>
                    {r.code}: {r.status === 'success' ? `Imported (${r.shipToCount} ship-to location(s))` : r.errors?.join('; ')}
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
        <h3 style={{ marginTop: 0 }}>Add Customer</h3>
        <p style={{ marginTop: -4, marginBottom: 12, fontSize: 12, color: '#888' }}>* required</p>
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <input placeholder="Bill To ID *" value={code} onChange={(e) => setCode(e.target.value)} required style={{ width: 120 }} />
            <input placeholder="Name *" value={name} onChange={(e) => setName(e.target.value)} required style={{ width: 200 }} />
            <input placeholder="Category" value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 140 }} />
            <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: 180 }} />
            <input placeholder="PAN" value={pan} onChange={(e) => setPan(e.target.value)} style={{ width: 120 }} />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <input placeholder="Billing Address" value={billingAddress} onChange={(e) => setBillingAddress(e.target.value)} style={{ width: 220 }} />
            <input placeholder="Pincode" value={pincode} onChange={(e) => setPincode(e.target.value)} style={{ width: 100 }} />
            <input placeholder="State" value={state} onChange={(e) => setState(e.target.value)} style={{ width: 140 }} />
            <input placeholder="Billing GST Number" value={gstNumber} onChange={(e) => setGstNumber(e.target.value)} style={{ width: 180 }} />
          </div>

          <h4 style={{ marginBottom: 4 }}>Ship-to Locations</h4>
          <p style={{ marginTop: 0, marginBottom: 8, fontSize: 12, color: '#888' }}>
            * Address, Pincode, and State are required only if you add a Ship-to Location row.
          </p>
          {shipTos.map((s, i) => (
            <div key={i} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <input placeholder="Ship To ID" value={s.shipToCode} onChange={(e) => updateShipTo(i, 'shipToCode', e.target.value)} style={{ width: 110 }} />
              <input placeholder="Address *" value={s.address} onChange={(e) => updateShipTo(i, 'address', e.target.value)} style={{ width: 180 }} />
              <input placeholder="Pincode *" value={s.pincode} onChange={(e) => updateShipTo(i, 'pincode', e.target.value)} style={{ width: 90 }} />
              <input placeholder="State *" value={s.state} onChange={(e) => updateShipTo(i, 'state', e.target.value)} style={{ width: 120 }} />
              <input placeholder="GST Number" value={s.gstNumber} onChange={(e) => updateShipTo(i, 'gstNumber', e.target.value)} style={{ width: 160 }} />
              <input placeholder="Warehouse Code (e.g. MH01)" value={s.warehouseCode} onChange={(e) => updateShipTo(i, 'warehouseCode', e.target.value)} style={{ width: 160 }} />
              <select value={s.deliveryZone} onChange={(e) => updateShipTo(i, 'deliveryZone', e.target.value)} style={{ width: 120 }}>
                <option value="">Local/Upcountry</option>
                <option value="LOCAL">Local</option>
                <option value="UPCOUNTRY">Upcountry</option>
              </select>
              <label style={{ fontSize: 13 }}>
                <input type="checkbox" checked={s.isDefault} onChange={(e) => updateShipTo(i, 'isDefault', e.target.checked)} /> Default
              </label>
              {shipTos.length > 1 && (
                <button type="button" onClick={() => removeShipTo(i)} style={{ color: 'crimson' }}>Remove</button>
              )}
            </div>
          ))}
          <button type="button" onClick={addShipTo} style={{ marginBottom: 12 }}>+ Add another Ship-to</button>

          {formError && <p style={{ color: 'crimson' }}>{formError}</p>}
          <div>
            <button type="submit">Add Customer</button>
          </div>
        </form>
      </div>
      )}

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 24 }}>
        <div style={cardStyle}><strong>{customerStats.total}</strong><div>Total Customers</div></div>
        <div style={cardStyle}><strong>{customerStats.active}</strong><div>Active</div></div>
        <div style={cardStyle}><strong>{customerStats.inactive}</strong><div>Inactive</div></div>
      </div>

      <h2 style={{ marginTop: 32 }}>Ship-to Zone Split</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 32 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'center', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>Local</th>
            <th style={{ textAlign: 'center', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>Upcountry</th>
            <th style={{ textAlign: 'center', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>Unclassified</th>
            <th style={{ textAlign: 'center', borderBottom: '1px solid #ccc', padding: '4px 8px' }}>Total Ship-tos</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ textAlign: 'center', padding: '4px 8px' }}>{localCount}</td>
            <td style={{ textAlign: 'center', padding: '4px 8px' }}>{upcountryCount}</td>
            <td style={{ textAlign: 'center', padding: '4px 8px' }}>{unclassifiedCount}</td>
            <td style={{ textAlign: 'center', padding: '4px 8px' }}><strong>{allShipTos.length}</strong></td>
          </tr>
        </tbody>
      </table>

      <h2 style={{ marginBottom: 8, cursor: 'pointer', userSelect: 'none' }} onClick={() => setShowList(!showList)}>
        {showList ? '▾' : '▸'} List of Customers
      </h2>

      {showList && (
        <>
          <input
            placeholder="Search by code, name, or category..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: '100%', padding: 8, marginBottom: 16, boxSizing: 'border-box' }}
          />

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'center', borderBottom: '2px solid #ccc' }}>
            <th style={{ padding: 8 }}>Code</th>
            <th style={{ padding: 8 }}>Name</th>
            <th style={{ padding: 8 }}>Category</th>
            <th style={{ padding: 8 }}>State</th>
            <th style={{ padding: 8 }}>Ship-to Count</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((c) => (
            <Fragment key={c.id}>
              <tr style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
                <td style={{ padding: 8, fontWeight: 'bold' }}>{c.code}</td>
                <td style={{ padding: 8 }}>{c.name}</td>
                <td style={{ padding: 8 }}>{c.category || '—'}</td>
                <td style={{ padding: 8 }}>{c.state || '—'}</td>
                <td style={{ padding: 8 }}>
                  <button onClick={() => setExpanded(expanded === c.id ? null : c.id)}>
                    {c.shipToLocations.length} {expanded === c.id ? '▲' : '▼'}
                  </button>
                </td>
                <td style={{ padding: 8 }}>{c.isActive ? 'Active' : 'Inactive'}</td>
                <td style={{ padding: 8, whiteSpace: 'nowrap' }}>
                  <button onClick={() => handleDeactivate(c.id, c.isActive)}>
                    {c.isActive ? 'Deactivate' : 'Reactivate'}
                  </button>
                  <button onClick={() => handleDelete(c.id, c.code)} style={{ marginLeft: 6, color: 'crimson' }}>
                    Delete
                  </button>
                </td>
              </tr>
              {expanded === c.id && (
                <tr>
                  <td colSpan={7} style={{ padding: 12, background: '#fafafa' }}>
                    {c.shipToLocations.length === 0 ? (
                      <em>No ship-to locations added.</em>
                    ) : (
                      <table style={{ width: '100%' }}>
                        <thead>
                          <tr style={{ textAlign: 'center', fontSize: 13, color: '#666' }}>
                            <th style={{ padding: 4 }}>Ship To ID</th>
                            <th style={{ padding: 4 }}>Address</th>
                            <th style={{ padding: 4 }}>Pincode</th>
                            <th style={{ padding: 4 }}>State</th>
                            <th style={{ padding: 4 }}>GST Number</th>
                            <th style={{ padding: 4 }}>Serving Warehouse</th>
                            <th style={{ padding: 4 }}>Local/Upcountry</th>
                            <th style={{ padding: 4 }}>Default?</th>
                          </tr>
                        </thead>
                        <tbody>
                          {c.shipToLocations.map((s) => (
                            <tr key={s.id} style={{ textAlign: 'center' }}>
                              <td style={{ padding: 4 }}>{s.shipToCode || '—'}</td>
                              <td style={{ padding: 4 }}>{s.address}</td>
                              <td style={{ padding: 4 }}>{s.pincode}</td>
                              <td style={{ padding: 4 }}>{s.state}</td>
                              <td style={{ padding: 4 }}>{s.gstNumber || '—'}</td>
                              <td style={{ padding: 4 }}>
                                {s.warehouse ? `${s.warehouse.code} — ${s.warehouse.name}` : '—'}
                              </td>
                              <td style={{ padding: 4 }}>
                                {s.deliveryZone === 'LOCAL' ? 'Local' : s.deliveryZone === 'UPCOUNTRY' ? 'Upcountry' : '—'}
                              </td>
                              <td style={{ padding: 4 }}>{s.isDefault ? 'Yes' : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>

      {filtered.length === 0 && <p style={{ marginTop: 16 }}>No customers found.</p>}
        </>
      )}
    </div>
  );
}

export default CustomersPage;

const cardStyle: React.CSSProperties = {
  border: '1px solid #ccc',
  borderRadius: 8,
  padding: '12px 16px',
  textAlign: 'center',
  minWidth: 100,
};
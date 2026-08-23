import { useEffect, useState } from 'react';

type ShipTo = {
  id: string;
  address: string;
  pincode: string;
  state: string;
  gstNumber?: string;
  isDefault: boolean;
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

type ShipToInput = { address: string; pincode: string; state: string; gstNumber: string; isDefault: boolean };

function authHeaders() {
  const token = localStorage.getItem('token');
  return { Authorization: `Bearer ${token}` };
}

const emptyShipTo: ShipToInput = { address: '', pincode: '', state: '', gstNumber: '', isDefault: false };

function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

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

  const loadCustomers = () => {
    fetch('http://localhost:3000/customers', { headers: authHeaders() })
      .then((res) => res.json())
      .then((data) => setCustomers(data));
  };

  useEffect(() => {
    loadCustomers();
  }, []);

  const updateShipTo = (index: number, field: keyof ShipToInput, value: any) => {
    const copy = [...shipTos];
    (copy[index] as any)[field] = value;
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

    const validShipTos = shipTos.filter((s) => s.address || s.pincode || s.state);

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

  const filtered = customers.filter(
    (c) =>
      c.code.toLowerCase().includes(search.toLowerCase()) ||
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      (c.category || '').toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div style={{ maxWidth: 1000, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1>Customer Master</h1>

      <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>Add Customer</h3>
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <input placeholder="Code" value={code} onChange={(e) => setCode(e.target.value)} required style={{ width: 120 }} />
            <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required style={{ width: 200 }} />
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

          <h4>Ship-to Locations</h4>
          {shipTos.map((s, i) => (
            <div key={i} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <input placeholder="Address" value={s.address} onChange={(e) => updateShipTo(i, 'address', e.target.value)} style={{ width: 200 }} />
              <input placeholder="Pincode" value={s.pincode} onChange={(e) => updateShipTo(i, 'pincode', e.target.value)} style={{ width: 100 }} />
              <input placeholder="State" value={s.state} onChange={(e) => updateShipTo(i, 'state', e.target.value)} style={{ width: 140 }} />
              <input placeholder="GST Number" value={s.gstNumber} onChange={(e) => updateShipTo(i, 'gstNumber', e.target.value)} style={{ width: 180 }} />
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

      <input
        placeholder="Search by code, name, or category..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ width: '100%', padding: 8, marginBottom: 16, boxSizing: 'border-box' }}
      />

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #ccc' }}>
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
            <>
              <tr key={c.id} style={{ borderBottom: '1px solid #eee' }}>
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
                          <tr style={{ textAlign: 'left', fontSize: 13, color: '#666' }}>
                            <th style={{ padding: 4 }}>Address</th>
                            <th style={{ padding: 4 }}>Pincode</th>
                            <th style={{ padding: 4 }}>State</th>
                            <th style={{ padding: 4 }}>GST Number</th>
                            <th style={{ padding: 4 }}>Default?</th>
                          </tr>
                        </thead>
                        <tbody>
                          {c.shipToLocations.map((s) => (
                            <tr key={s.id}>
                              <td style={{ padding: 4 }}>{s.address}</td>
                              <td style={{ padding: 4 }}>{s.pincode}</td>
                              <td style={{ padding: 4 }}>{s.state}</td>
                              <td style={{ padding: 4 }}>{s.gstNumber || '—'}</td>
                              <td style={{ padding: 4 }}>{s.isDefault ? 'Yes' : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>

      {filtered.length === 0 && <p style={{ marginTop: 16 }}>No customers found.</p>}
    </div>
  );
}

export default CustomersPage;
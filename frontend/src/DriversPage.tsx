import { useEffect, useState } from 'react';

type Driver = {
  id: string;
  name: string;
  phone?: string;
  licenseNumber?: string;
  licenseExpiry?: string;
  isBlacklisted: boolean;
  blacklistReason?: string;
  isActive: boolean;
};

function authHeaders() {
  const token = localStorage.getItem('token');
  return { Authorization: `Bearer ${token}` };
}

function fmtDate(d?: string) {
  return d ? new Date(d).toLocaleDateString() : '—';
}

const emptyForm = { name: '', phone: '', licenseNumber: '', licenseExpiry: '', isBlacklisted: false, blacklistReason: '' };

function DriversPage() {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [search, setSearch] = useState('');
  const [showList, setShowList] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState('');
  const [deleteAllResult, setDeleteAllResult] = useState<string | null>(null);

  const loadDrivers = () => {
    fetch('http://localhost:3000/drivers', { headers: authHeaders() })
      .then((res) => {
        if (res.status === 401) { localStorage.clear(); window.location.reload(); return []; }
        return res.json();
      })
      .then((data) => setDrivers(Array.isArray(data) ? data : []));
  };

  useEffect(() => {
    loadDrivers();
  }, []);

  const resetForm = () => {
    setForm(emptyForm);
    setEditingId(null);
    setShowForm(false);
    setFormError('');
  };

  const startEdit = (d: Driver) => {
    setForm({
      name: d.name,
      phone: d.phone || '',
      licenseNumber: d.licenseNumber || '',
      licenseExpiry: d.licenseExpiry ? d.licenseExpiry.slice(0, 10) : '',
      isBlacklisted: d.isBlacklisted,
      blacklistReason: d.blacklistReason || '',
    });
    setEditingId(d.id);
    setShowForm(true);
    setFormError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    const body = { ...form, licenseExpiry: form.licenseExpiry || undefined };
    const url = editingId ? `http://localhost:3000/drivers/${editingId}` : 'http://localhost:3000/drivers';
    const res = await fetch(url, {
      method: editingId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      setFormError(Array.isArray(data.message) ? data.message.join(' | ') : data.message || 'Could not save this driver.');
      return;
    }
    resetForm();
    loadDrivers();
  };

  const handleDeactivate = async (id: string, isActive: boolean) => {
    const action = isActive ? 'deactivate' : 'reactivate';
    await fetch(`http://localhost:3000/drivers/${id}/${action}`, { method: 'PATCH', headers: authHeaders() });
    loadDrivers();
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Permanently delete ${name}? This cannot be undone.`)) return;
    const res = await fetch(`http://localhost:3000/drivers/${id}`, { method: 'DELETE', headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) {
      alert(data.message || 'Could not delete this driver.');
      return;
    }
    loadDrivers();
  };

  const handleDeleteAll = async () => {
    if (!confirm('Permanently delete ALL drivers that have no linked gate entries? This cannot be undone.')) return;
    const res = await fetch('http://localhost:3000/drivers/all', { method: 'DELETE', headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) {
      setDeleteAllResult(`Delete All failed: ${Array.isArray(data.message) ? data.message.join(' | ') : data.message || 'Unknown error.'}`);
      return;
    }
    setDeleteAllResult(`Deleted ${data.deletedCount} driver(s). ${data.blockedCount} blocked (have linked gate entries)${data.blockedCodes.length ? ': ' + data.blockedCodes.join(', ') : ''}.`);
    loadDrivers();
  };

  const stats = {
    total: drivers.length,
    active: drivers.filter((d) => d.isActive).length,
    inactive: drivers.filter((d) => !d.isActive).length,
    blacklisted: drivers.filter((d) => d.isBlacklisted).length,
  };

  const filtered = drivers.filter((d) => {
    const q = search.toLowerCase();
    return d.name.toLowerCase().includes(q) || (d.phone || '').includes(q) || (d.licenseNumber || '').toLowerCase().includes(q);
  });

  return (
    <div style={{ maxWidth: 1100, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1>Driver Master</h1>

      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 8 }}>
        <button onClick={handleDeleteAll} style={{ color: 'crimson' }}>Delete All</button>
        <button type="button" onClick={() => (showForm ? resetForm() : setShowForm(true))}>
          {showForm ? '▾ Hide manual entry' : '▸ Register Driver'}
        </button>
      </div>

      {deleteAllResult && <p style={{ textAlign: 'center', marginBottom: 24 }}>{deleteAllResult}</p>}

      {showForm && (
        <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>{editingId ? 'Edit Driver' : 'Register Driver'}</h3>
          <p style={{ marginTop: -4, marginBottom: 12, fontSize: 12, color: '#888' }}>* required</p>
          <form onSubmit={handleSubmit}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <input placeholder="Name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required style={{ width: 180 }} />
              <input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} style={{ width: 150 }} />
              <input placeholder="License Number" value={form.licenseNumber} onChange={(e) => setForm({ ...form, licenseNumber: e.target.value })} style={{ width: 170 }} />
              <input type="date" placeholder="License Expiry" value={form.licenseExpiry} onChange={(e) => setForm({ ...form, licenseExpiry: e.target.value })} style={{ width: 150 }} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label>
                <input type="checkbox" checked={form.isBlacklisted} onChange={(e) => setForm({ ...form, isBlacklisted: e.target.checked })} /> Blacklisted
              </label>
              {form.isBlacklisted && (
                <input
                  placeholder="Blacklist Reason *"
                  value={form.blacklistReason}
                  onChange={(e) => setForm({ ...form, blacklistReason: e.target.value })}
                  style={{ width: 300, marginLeft: 12 }}
                />
              )}
            </div>
            {formError && <p style={{ color: 'crimson' }}>{formError}</p>}
            <div>
              <button type="submit">{editingId ? 'Save Changes' : 'Register Driver'}</button>
              <button type="button" onClick={resetForm} style={{ marginLeft: 8 }}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 24 }}>
        <div style={cardStyle}><strong>{stats.total}</strong><div>Total Drivers</div></div>
        <div style={cardStyle}><strong>{stats.active}</strong><div>Active</div></div>
        <div style={cardStyle}><strong>{stats.inactive}</strong><div>Inactive</div></div>
        <div style={cardStyle}><strong>{stats.blacklisted}</strong><div>Blacklisted</div></div>
      </div>

      <h2 style={{ marginBottom: 8, cursor: 'pointer', userSelect: 'none' }} onClick={() => setShowList(!showList)}>
        {showList ? '▾' : '▸'} List of Drivers
      </h2>

      {showList && (
        <>
          <input
            placeholder="Search by name, phone, or license number..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: '100%', padding: 8, marginBottom: 16, boxSizing: 'border-box' }}
          />

          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 32 }}>
            <thead>
              <tr style={{ textAlign: 'center', borderBottom: '2px solid #ccc' }}>
                <th style={{ padding: 8 }}>Name</th>
                <th style={{ padding: 8 }}>Phone</th>
                <th style={{ padding: 8 }}>License Number</th>
                <th style={{ padding: 8 }}>License Expiry</th>
                <th style={{ padding: 8 }}>Blacklisted</th>
                <th style={{ padding: 8 }}>Status</th>
                <th style={{ padding: 8 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr key={d.id} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: 8, fontWeight: 'bold' }}>{d.name}</td>
                  <td style={{ padding: 8 }}>{d.phone || '—'}</td>
                  <td style={{ padding: 8 }}>{d.licenseNumber || '—'}</td>
                  <td style={{ padding: 8 }}>{fmtDate(d.licenseExpiry)}</td>
                  <td style={{ padding: 8 }} title={d.blacklistReason || ''}>{d.isBlacklisted ? 'Yes' : 'No'}</td>
                  <td style={{ padding: 8 }}>{d.isActive ? 'Active' : 'Inactive'}</td>
                  <td style={{ padding: 8, whiteSpace: 'nowrap' }}>
                    <button onClick={() => startEdit(d)}>Edit</button>
                    <button onClick={() => handleDeactivate(d.id, d.isActive)} style={{ marginLeft: 6 }}>
                      {d.isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                    <button onClick={() => handleDelete(d.id, d.name)} style={{ marginLeft: 6, color: 'crimson' }}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {filtered.length === 0 && <p style={{ marginTop: 16 }}>No drivers found.</p>}
        </>
      )}
    </div>
  );
}

export default DriversPage;

const cardStyle: React.CSSProperties = {
  border: '1px solid #ccc',
  borderRadius: 8,
  padding: '12px 16px',
  textAlign: 'center',
  minWidth: 100,
};

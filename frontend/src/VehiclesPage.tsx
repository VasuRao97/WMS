import { useEffect, useState } from 'react';

type VehicleType = { id: string; name: string; segment: string; maxTonnage: number };

type Vehicle = {
  id: string;
  vehicleNumber: string;
  vehicleType: VehicleType;
  lengthFt?: number;
  widthFt?: number;
  heightFt?: number;
  rcNumber?: string;
  rcExpiry?: string;
  insuranceNumber?: string;
  insuranceExpiry?: string;
  pucNumber?: string;
  pucExpiry?: string;
  fitnessNumber?: string;
  fitnessExpiry?: string;
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

const emptyForm = {
  vehicleNumber: '',
  vehicleTypeId: '',
  lengthFt: '',
  widthFt: '',
  heightFt: '',
  rcNumber: '',
  rcExpiry: '',
  insuranceNumber: '',
  insuranceExpiry: '',
  pucNumber: '',
  pucExpiry: '',
  fitnessNumber: '',
  fitnessExpiry: '',
  isBlacklisted: false,
  blacklistReason: '',
};

function VehiclesPage() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [vehicleTypes, setVehicleTypes] = useState<VehicleType[]>([]);
  const [search, setSearch] = useState('');
  const [showList, setShowList] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState('');
  const [deleteAllResult, setDeleteAllResult] = useState<string | null>(null);

  const loadVehicles = () => {
    fetch('http://localhost:3000/vehicles', { headers: authHeaders() })
      .then((res) => {
        if (res.status === 401) { localStorage.clear(); window.location.reload(); return []; }
        return res.json();
      })
      .then((data) => setVehicles(Array.isArray(data) ? data : []));
  };

  const loadVehicleTypes = () => {
    fetch('http://localhost:3000/vehicle-types', { headers: authHeaders() })
      .then((res) => (res.status === 401 ? [] : res.json()))
      .then((data) => setVehicleTypes(Array.isArray(data) ? data : []));
  };

  useEffect(() => {
    loadVehicles();
    loadVehicleTypes();
  }, []);

  const resetForm = () => {
    setForm(emptyForm);
    setEditingId(null);
    setShowForm(false);
    setFormError('');
  };

  const startEdit = (v: Vehicle) => {
    setForm({
      vehicleNumber: v.vehicleNumber,
      vehicleTypeId: v.vehicleType.id,
      lengthFt: v.lengthFt != null ? String(v.lengthFt) : '',
      widthFt: v.widthFt != null ? String(v.widthFt) : '',
      heightFt: v.heightFt != null ? String(v.heightFt) : '',
      rcNumber: v.rcNumber || '',
      rcExpiry: v.rcExpiry ? v.rcExpiry.slice(0, 10) : '',
      insuranceNumber: v.insuranceNumber || '',
      insuranceExpiry: v.insuranceExpiry ? v.insuranceExpiry.slice(0, 10) : '',
      pucNumber: v.pucNumber || '',
      pucExpiry: v.pucExpiry ? v.pucExpiry.slice(0, 10) : '',
      fitnessNumber: v.fitnessNumber || '',
      fitnessExpiry: v.fitnessExpiry ? v.fitnessExpiry.slice(0, 10) : '',
      isBlacklisted: v.isBlacklisted,
      blacklistReason: v.blacklistReason || '',
    });
    setEditingId(v.id);
    setShowForm(true);
    setFormError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    const body = {
      ...form,
      lengthFt: form.lengthFt || undefined,
      widthFt: form.widthFt || undefined,
      heightFt: form.heightFt || undefined,
      rcExpiry: form.rcExpiry || undefined,
      insuranceExpiry: form.insuranceExpiry || undefined,
      pucExpiry: form.pucExpiry || undefined,
      fitnessExpiry: form.fitnessExpiry || undefined,
    };
    const url = editingId ? `http://localhost:3000/vehicles/${editingId}` : 'http://localhost:3000/vehicles';
    const res = await fetch(url, {
      method: editingId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      setFormError(Array.isArray(data.message) ? data.message.join(' | ') : data.message || 'Could not save this vehicle.');
      return;
    }
    resetForm();
    loadVehicles();
  };

  const handleDeactivate = async (id: string, isActive: boolean) => {
    const action = isActive ? 'deactivate' : 'reactivate';
    await fetch(`http://localhost:3000/vehicles/${id}/${action}`, { method: 'PATCH', headers: authHeaders() });
    loadVehicles();
  };

  const handleDelete = async (id: string, vehicleNumber: string) => {
    if (!confirm(`Permanently delete ${vehicleNumber}? This cannot be undone.`)) return;
    const res = await fetch(`http://localhost:3000/vehicles/${id}`, { method: 'DELETE', headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) {
      alert(data.message || 'Could not delete this vehicle.');
      return;
    }
    loadVehicles();
  };

  const handleDeleteAll = async () => {
    if (!confirm('Permanently delete ALL vehicles that have no linked gate entries? This cannot be undone.')) return;
    const res = await fetch('http://localhost:3000/vehicles/all', { method: 'DELETE', headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) {
      setDeleteAllResult(`Delete All failed: ${Array.isArray(data.message) ? data.message.join(' | ') : data.message || 'Unknown error.'}`);
      return;
    }
    setDeleteAllResult(`Deleted ${data.deletedCount} vehicle(s). ${data.blockedCount} blocked (have linked gate entries)${data.blockedCodes.length ? ': ' + data.blockedCodes.join(', ') : ''}.`);
    loadVehicles();
  };

  const stats = {
    total: vehicles.length,
    active: vehicles.filter((v) => v.isActive).length,
    inactive: vehicles.filter((v) => !v.isActive).length,
    blacklisted: vehicles.filter((v) => v.isBlacklisted).length,
  };

  const filtered = vehicles.filter((v) => {
    const q = search.toLowerCase();
    return v.vehicleNumber.toLowerCase().includes(q) || v.vehicleType.name.toLowerCase().includes(q);
  });

  return (
    <div style={{ maxWidth: 1100, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1>Vehicle Master</h1>

      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 8 }}>
        <button onClick={handleDeleteAll} style={{ color: 'crimson' }}>Delete All</button>
        <button type="button" onClick={() => (showForm ? resetForm() : setShowForm(true))}>
          {showForm ? '▾ Hide manual entry' : '▸ Register Vehicle'}
        </button>
      </div>

      {deleteAllResult && <p style={{ textAlign: 'center', marginBottom: 24 }}>{deleteAllResult}</p>}

      {showForm && (
        <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>{editingId ? 'Edit Vehicle' : 'Register Vehicle'}</h3>
          <p style={{ marginTop: -4, marginBottom: 12, fontSize: 12, color: '#888' }}>* required</p>
          <form onSubmit={handleSubmit}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <input placeholder="Vehicle Number *" value={form.vehicleNumber} onChange={(e) => setForm({ ...form, vehicleNumber: e.target.value })} required style={{ width: 160 }} />
              <select value={form.vehicleTypeId} onChange={(e) => setForm({ ...form, vehicleTypeId: e.target.value })} required style={{ width: 260 }}>
                <option value="">Vehicle Type *</option>
                {vehicleTypes.map((vt) => (
                  <option key={vt.id} value={vt.id}>{vt.name} ({vt.segment}, {Number(vt.maxTonnage)} T)</option>
                ))}
              </select>
            </div>
            <p style={{ marginTop: 0, marginBottom: 4, fontSize: 13, color: '#666' }}>
              Actual measured dimensions for THIS truck (optional — overrides the Vehicle Type's generic size when known):
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <input placeholder="Length (ft)" value={form.lengthFt} onChange={(e) => setForm({ ...form, lengthFt: e.target.value })} style={{ width: 110 }} />
              <input placeholder="Width (ft)" value={form.widthFt} onChange={(e) => setForm({ ...form, widthFt: e.target.value })} style={{ width: 110 }} />
              <input placeholder="Height (ft)" value={form.heightFt} onChange={(e) => setForm({ ...form, heightFt: e.target.value })} style={{ width: 110 }} />
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <input placeholder="RC Number" value={form.rcNumber} onChange={(e) => setForm({ ...form, rcNumber: e.target.value })} style={{ width: 150 }} />
              <input type="date" placeholder="RC Expiry" value={form.rcExpiry} onChange={(e) => setForm({ ...form, rcExpiry: e.target.value })} style={{ width: 150 }} />
              <input placeholder="Insurance Number" value={form.insuranceNumber} onChange={(e) => setForm({ ...form, insuranceNumber: e.target.value })} style={{ width: 150 }} />
              <input type="date" placeholder="Insurance Expiry" value={form.insuranceExpiry} onChange={(e) => setForm({ ...form, insuranceExpiry: e.target.value })} style={{ width: 150 }} />
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <input placeholder="PUC Number" value={form.pucNumber} onChange={(e) => setForm({ ...form, pucNumber: e.target.value })} style={{ width: 150 }} />
              <input type="date" placeholder="PUC Expiry" value={form.pucExpiry} onChange={(e) => setForm({ ...form, pucExpiry: e.target.value })} style={{ width: 150 }} />
              <input placeholder="Fitness Cert Number" value={form.fitnessNumber} onChange={(e) => setForm({ ...form, fitnessNumber: e.target.value })} style={{ width: 150 }} />
              <input type="date" placeholder="Fitness Expiry" value={form.fitnessExpiry} onChange={(e) => setForm({ ...form, fitnessExpiry: e.target.value })} style={{ width: 150 }} />
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
              <button type="submit">{editingId ? 'Save Changes' : 'Register Vehicle'}</button>
              <button type="button" onClick={resetForm} style={{ marginLeft: 8 }}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 24 }}>
        <div style={cardStyle}><strong>{stats.total}</strong><div>Total Vehicles</div></div>
        <div style={cardStyle}><strong>{stats.active}</strong><div>Active</div></div>
        <div style={cardStyle}><strong>{stats.inactive}</strong><div>Inactive</div></div>
        <div style={cardStyle}><strong>{stats.blacklisted}</strong><div>Blacklisted</div></div>
      </div>

      <h2 style={{ marginBottom: 8, cursor: 'pointer', userSelect: 'none' }} onClick={() => setShowList(!showList)}>
        {showList ? '▾' : '▸'} List of Vehicles
      </h2>

      {showList && (
        <>
          <input
            placeholder="Search by vehicle number or type..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: '100%', padding: 8, marginBottom: 16, boxSizing: 'border-box' }}
          />

          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 32 }}>
            <thead>
              <tr style={{ textAlign: 'center', borderBottom: '2px solid #ccc' }}>
                <th style={{ padding: 8 }}>Vehicle Number</th>
                <th style={{ padding: 8 }}>Vehicle Type</th>
                <th style={{ padding: 8 }}>Dimensions (ft)</th>
                <th style={{ padding: 8 }}>RC Expiry</th>
                <th style={{ padding: 8 }}>Insurance Expiry</th>
                <th style={{ padding: 8 }}>Blacklisted</th>
                <th style={{ padding: 8 }}>Status</th>
                <th style={{ padding: 8 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((v) => (
                <tr key={v.id} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: 8, fontWeight: 'bold' }}>{v.vehicleNumber}</td>
                  <td style={{ padding: 8 }} title={`${v.vehicleType.segment}, ${v.vehicleType.maxTonnage} T max`}>{v.vehicleType.name}</td>
                  <td style={{ padding: 8 }}>
                    {v.lengthFt != null ? `${v.lengthFt} × ${v.widthFt} × ${v.heightFt}` : '—'}
                  </td>
                  <td style={{ padding: 8 }}>{fmtDate(v.rcExpiry)}</td>
                  <td style={{ padding: 8 }}>{fmtDate(v.insuranceExpiry)}</td>
                  <td style={{ padding: 8 }} title={v.blacklistReason || ''}>{v.isBlacklisted ? 'Yes' : 'No'}</td>
                  <td style={{ padding: 8 }}>{v.isActive ? 'Active' : 'Inactive'}</td>
                  <td style={{ padding: 8, whiteSpace: 'nowrap' }}>
                    <button onClick={() => startEdit(v)}>Edit</button>
                    <button onClick={() => handleDeactivate(v.id, v.isActive)} style={{ marginLeft: 6 }}>
                      {v.isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                    <button onClick={() => handleDelete(v.id, v.vehicleNumber)} style={{ marginLeft: 6, color: 'crimson' }}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {filtered.length === 0 && <p style={{ marginTop: 16 }}>No vehicles found.</p>}
        </>
      )}
    </div>
  );
}

export default VehiclesPage;

const cardStyle: React.CSSProperties = {
  border: '1px solid #ccc',
  borderRadius: 8,
  padding: '12px 16px',
  textAlign: 'center',
  minWidth: 100,
};

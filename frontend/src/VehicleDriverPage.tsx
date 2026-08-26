import { useEffect, useState } from 'react';

// Vehicle & Driver Master (2026-08-27) — the page the client asked for after
// flagging that removing the standalone Vehicles/Drivers tabs (when Gate &
// Yard was built) also removed the only way to EDIT an already-registered
// Vehicle/Driver, including blacklisting one. Registration itself stays
// exactly where it is — the "Register Vehicle"/"Register Driver" buttons on
// GateYardPage — this page is populated by those registrations over time and
// exists purely to browse/search/edit/blacklist/deactivate/delete what's
// already on file. No create button here on purpose (confirmed with the
// client): editing opens a normal on-page form, not a modal — same
// "form doubles as edit form" pattern LocationsPage.tsx already uses, not a
// popup. No bulk Excel import either (confirmed) — registering a
// vehicle/driver is a one-time-per-record manual step, export only.

type VehicleType = { id: string; name: string; segment: string; maxTonnage: number };
type Vehicle = {
  id: string;
  vehicleNumber: string;
  vehicleType: VehicleType;
  maxTonnage?: number;
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
function jsonHeaders() {
  return { 'Content-Type': 'application/json', ...authHeaders() };
}
function errorText(data: any, fallback: string) {
  return Array.isArray(data?.message) ? data.message.join(' | ') : data?.message || fallback;
}
function fmtDate(d?: string) {
  return d ? d.slice(0, 10) : '—';
}

const emptyVehicleForm = {
  vehicleNumber: '', vehicleTypeId: '', lengthFt: '', widthFt: '', heightFt: '', maxTonnage: '',
  rcNumber: '', rcExpiry: '', insuranceNumber: '', insuranceExpiry: '', pucNumber: '', pucExpiry: '', fitnessNumber: '', fitnessExpiry: '',
  isBlacklisted: false, blacklistReason: '',
};
const emptyDriverForm = { name: '', phone: '', licenseNumber: '', licenseExpiry: '', isBlacklisted: false, blacklistReason: '' };

const cardStyle: React.CSSProperties = {
  border: '1px solid #ccc',
  borderRadius: 8,
  padding: '12px 16px',
  textAlign: 'center',
  minWidth: 100,
};

function VehicleDriverPage() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [vehicleTypes, setVehicleTypes] = useState<VehicleType[]>([]);

  const [vehicleSearch, setVehicleSearch] = useState('');
  const [driverSearch, setDriverSearch] = useState('');
  const [showVehicleList, setShowVehicleList] = useState(true);
  const [showDriverList, setShowDriverList] = useState(true);

  const [editingVehicleId, setEditingVehicleId] = useState<string | null>(null);
  const [vehicleForm, setVehicleForm] = useState(emptyVehicleForm);
  const [vehicleFormError, setVehicleFormError] = useState('');

  const [editingDriverId, setEditingDriverId] = useState<string | null>(null);
  const [driverForm, setDriverForm] = useState(emptyDriverForm);
  const [driverFormError, setDriverFormError] = useState('');

  const [vehicleDeleteAllResult, setVehicleDeleteAllResult] = useState<string | null>(null);
  const [driverDeleteAllResult, setDriverDeleteAllResult] = useState<string | null>(null);

  const loadVehicles = () =>
    fetch('http://localhost:3000/vehicles', { headers: authHeaders() })
      .then((res) => {
        if (res.status === 401) { localStorage.clear(); window.location.reload(); return []; }
        return res.json();
      })
      .then((d) => setVehicles(Array.isArray(d) ? d : []));

  const loadDrivers = () =>
    fetch('http://localhost:3000/drivers', { headers: authHeaders() })
      .then((res) => {
        if (res.status === 401) { localStorage.clear(); window.location.reload(); return []; }
        return res.json();
      })
      .then((d) => setDrivers(Array.isArray(d) ? d : []));

  const loadVehicleTypes = () =>
    fetch('http://localhost:3000/vehicle-types', { headers: authHeaders() })
      .then((r) => (r.status === 401 ? [] : r.json()))
      .then((d) => setVehicleTypes(Array.isArray(d) ? d : []));

  useEffect(() => {
    loadVehicles();
    loadDrivers();
    loadVehicleTypes();
  }, []);

  // ---------- Vehicles ----------

  const startEditVehicle = (v: Vehicle) => {
    setVehicleForm({
      vehicleNumber: v.vehicleNumber,
      vehicleTypeId: v.vehicleType.id,
      lengthFt: v.lengthFt != null ? String(v.lengthFt) : '',
      widthFt: v.widthFt != null ? String(v.widthFt) : '',
      heightFt: v.heightFt != null ? String(v.heightFt) : '',
      maxTonnage: v.maxTonnage != null ? String(v.maxTonnage) : '',
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
    setEditingVehicleId(v.id);
    setVehicleFormError('');
  };

  const resetVehicleForm = () => {
    setVehicleForm(emptyVehicleForm);
    setEditingVehicleId(null);
    setVehicleFormError('');
  };

  // Only ever opens via startEditVehicle() — no create path on this page —
  // so editingVehicleId is always set by the time this fires.
  const handleVehicleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingVehicleId) return;
    setVehicleFormError('');
    const body = {
      ...vehicleForm,
      lengthFt: vehicleForm.lengthFt || undefined,
      widthFt: vehicleForm.widthFt || undefined,
      heightFt: vehicleForm.heightFt || undefined,
      maxTonnage: vehicleForm.maxTonnage || undefined,
      rcExpiry: vehicleForm.rcExpiry || undefined,
      insuranceExpiry: vehicleForm.insuranceExpiry || undefined,
      pucExpiry: vehicleForm.pucExpiry || undefined,
      fitnessExpiry: vehicleForm.fitnessExpiry || undefined,
    };
    const res = await fetch(`http://localhost:3000/vehicles/${editingVehicleId}`, { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) {
      setVehicleFormError(errorText(data, 'Could not save this vehicle.'));
      return;
    }
    resetVehicleForm();
    loadVehicles();
  };

  const handleVehicleToggleActive = async (v: Vehicle) => {
    const action = v.isActive ? 'deactivate' : 'reactivate';
    await fetch(`http://localhost:3000/vehicles/${v.id}/${action}`, { method: 'PATCH', headers: authHeaders() });
    loadVehicles();
  };

  const handleVehicleDelete = async (v: Vehicle) => {
    if (!confirm(`Permanently delete ${v.vehicleNumber}? This cannot be undone.`)) return;
    const res = await fetch(`http://localhost:3000/vehicles/${v.id}`, { method: 'DELETE', headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) { alert(errorText(data, 'Could not delete this vehicle.')); return; }
    loadVehicles();
  };

  const handleVehicleDeleteAll = async () => {
    if (!confirm('Permanently delete ALL vehicles with no gate-entry history? This cannot be undone.')) return;
    const res = await fetch('http://localhost:3000/vehicles/all', { method: 'DELETE', headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) { setVehicleDeleteAllResult(`Delete All failed: ${errorText(data, 'Unknown error.')}`); return; }
    setVehicleDeleteAllResult(`Deleted ${data.deletedCount} vehicle(s).${data.blockedCount ? ` ${data.blockedCount} blocked (linked to gate entries).` : ''}`);
    loadVehicles();
  };

  const handleVehicleExport = () => {
    fetch('http://localhost:3000/vehicles/export', { headers: authHeaders() })
      .then((res) => res.blob())
      .then((blob) => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'Vehicle_Master_Export.xlsx';
        a.click();
        window.URL.revokeObjectURL(url);
      });
  };

  const vehicleStats = {
    total: vehicles.length,
    active: vehicles.filter((v) => v.isActive).length,
    inactive: vehicles.filter((v) => !v.isActive).length,
    blacklisted: vehicles.filter((v) => v.isBlacklisted).length,
  };

  const filteredVehicles = vehicles.filter((v) => {
    const q = vehicleSearch.toLowerCase();
    return (
      v.vehicleNumber.toLowerCase().includes(q) ||
      v.vehicleType.name.toLowerCase().includes(q) ||
      v.vehicleType.segment.toLowerCase().includes(q)
    );
  });

  // ---------- Drivers ----------

  const startEditDriver = (d: Driver) => {
    setDriverForm({
      name: d.name,
      phone: d.phone || '',
      licenseNumber: d.licenseNumber || '',
      licenseExpiry: d.licenseExpiry ? d.licenseExpiry.slice(0, 10) : '',
      isBlacklisted: d.isBlacklisted,
      blacklistReason: d.blacklistReason || '',
    });
    setEditingDriverId(d.id);
    setDriverFormError('');
  };

  const resetDriverForm = () => {
    setDriverForm(emptyDriverForm);
    setEditingDriverId(null);
    setDriverFormError('');
  };

  const handleDriverSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingDriverId) return;
    setDriverFormError('');
    const body = { ...driverForm, licenseExpiry: driverForm.licenseExpiry || undefined };
    const res = await fetch(`http://localhost:3000/drivers/${editingDriverId}`, { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) {
      setDriverFormError(errorText(data, 'Could not save this driver.'));
      return;
    }
    resetDriverForm();
    loadDrivers();
  };

  const handleDriverToggleActive = async (d: Driver) => {
    const action = d.isActive ? 'deactivate' : 'reactivate';
    await fetch(`http://localhost:3000/drivers/${d.id}/${action}`, { method: 'PATCH', headers: authHeaders() });
    loadDrivers();
  };

  const handleDriverDelete = async (d: Driver) => {
    if (!confirm(`Permanently delete ${d.name}? This cannot be undone.`)) return;
    const res = await fetch(`http://localhost:3000/drivers/${d.id}`, { method: 'DELETE', headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) { alert(errorText(data, 'Could not delete this driver.')); return; }
    loadDrivers();
  };

  const handleDriverDeleteAll = async () => {
    if (!confirm('Permanently delete ALL drivers with no gate-entry history? This cannot be undone.')) return;
    const res = await fetch('http://localhost:3000/drivers/all', { method: 'DELETE', headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) { setDriverDeleteAllResult(`Delete All failed: ${errorText(data, 'Unknown error.')}`); return; }
    setDriverDeleteAllResult(`Deleted ${data.deletedCount} driver(s).${data.blockedCount ? ` ${data.blockedCount} blocked (linked to gate entries).` : ''}`);
    loadDrivers();
  };

  const handleDriverExport = () => {
    fetch('http://localhost:3000/drivers/export', { headers: authHeaders() })
      .then((res) => res.blob())
      .then((blob) => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'Driver_Master_Export.xlsx';
        a.click();
        window.URL.revokeObjectURL(url);
      });
  };

  const driverStats = {
    total: drivers.length,
    active: drivers.filter((d) => d.isActive).length,
    inactive: drivers.filter((d) => !d.isActive).length,
    blacklisted: drivers.filter((d) => d.isBlacklisted).length,
  };

  const filteredDrivers = drivers.filter((d) => {
    const q = driverSearch.toLowerCase();
    return d.name.toLowerCase().includes(q) || (d.phone || '').toLowerCase().includes(q) || (d.licenseNumber || '').toLowerCase().includes(q);
  });

  return (
    <div style={{ maxWidth: 1050, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1 style={{ textAlign: 'center' }}>Vehicle &amp; Driver Master</h1>
      <p style={{ textAlign: 'center', color: '#666', fontSize: 13, marginTop: -8 }}>
        Registration happens from Gate &amp; Yard's Register Vehicle/Register Driver buttons — this page is for browsing, editing, and blacklisting what's already on file.
      </p>

      {/* ===================== Vehicles ===================== */}
      <h2 style={{ marginTop: 32 }}>Vehicles</h2>

      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 8 }}>
        <button onClick={handleVehicleExport}>Export to Excel</button>
        <button onClick={handleVehicleDeleteAll} style={{ color: 'crimson' }}>Delete All</button>
      </div>

      {vehicleDeleteAllResult && <p style={{ textAlign: 'center' }}>{vehicleDeleteAllResult}</p>}

      {editingVehicleId && (
        <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>Edit Vehicle — {vehicleForm.vehicleNumber}</h3>
          <form onSubmit={handleVehicleSubmit}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <input placeholder="Vehicle Number *" value={vehicleForm.vehicleNumber} onChange={(e) => setVehicleForm({ ...vehicleForm, vehicleNumber: e.target.value })} required style={{ width: 160 }} />
              <select value={vehicleForm.vehicleTypeId} onChange={(e) => setVehicleForm({ ...vehicleForm, vehicleTypeId: e.target.value })} required style={{ width: 260 }}>
                <option value="">Vehicle Type *</option>
                {vehicleTypes.map((vt) => (
                  <option key={vt.id} value={vt.id}>{vt.name} ({vt.segment}, {Number(vt.maxTonnage)} T)</option>
                ))}
              </select>
            </div>
            <p style={{ marginTop: 0, marginBottom: 4, fontSize: 13, color: '#666' }}>Actual capacity/dimensions for THIS truck (optional — overrides the Vehicle Type's generic values when known):</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <input placeholder="Max Capacity (Ton)" value={vehicleForm.maxTonnage} onChange={(e) => setVehicleForm({ ...vehicleForm, maxTonnage: e.target.value })} style={{ width: 130 }} />
              <input placeholder="Length (ft)" value={vehicleForm.lengthFt} onChange={(e) => setVehicleForm({ ...vehicleForm, lengthFt: e.target.value })} style={{ width: 100 }} />
              <input placeholder="Width (ft)" value={vehicleForm.widthFt} onChange={(e) => setVehicleForm({ ...vehicleForm, widthFt: e.target.value })} style={{ width: 100 }} />
              <input placeholder="Height (ft)" value={vehicleForm.heightFt} onChange={(e) => setVehicleForm({ ...vehicleForm, heightFt: e.target.value })} style={{ width: 100 }} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr 160px', gap: 8, alignItems: 'center', marginBottom: 12 }}>
              <label>RC</label>
              <input placeholder="RC Number" value={vehicleForm.rcNumber} onChange={(e) => setVehicleForm({ ...vehicleForm, rcNumber: e.target.value })} />
              <div>
                <span style={{ fontSize: 12, color: '#666', marginRight: 6 }}>Expiry</span>
                <input type="date" value={vehicleForm.rcExpiry} onChange={(e) => setVehicleForm({ ...vehicleForm, rcExpiry: e.target.value })} />
              </div>

              <label>Insurance</label>
              <input placeholder="Insurance Number" value={vehicleForm.insuranceNumber} onChange={(e) => setVehicleForm({ ...vehicleForm, insuranceNumber: e.target.value })} />
              <div>
                <span style={{ fontSize: 12, color: '#666', marginRight: 6 }}>Expiry</span>
                <input type="date" value={vehicleForm.insuranceExpiry} onChange={(e) => setVehicleForm({ ...vehicleForm, insuranceExpiry: e.target.value })} />
              </div>

              <label>PUC</label>
              <input placeholder="PUC Number" value={vehicleForm.pucNumber} onChange={(e) => setVehicleForm({ ...vehicleForm, pucNumber: e.target.value })} />
              <div>
                <span style={{ fontSize: 12, color: '#666', marginRight: 6 }}>Expiry</span>
                <input type="date" value={vehicleForm.pucExpiry} onChange={(e) => setVehicleForm({ ...vehicleForm, pucExpiry: e.target.value })} />
              </div>

              <label>Fitness Cert</label>
              <input placeholder="Fitness Cert Number" value={vehicleForm.fitnessNumber} onChange={(e) => setVehicleForm({ ...vehicleForm, fitnessNumber: e.target.value })} />
              <div>
                <span style={{ fontSize: 12, color: '#666', marginRight: 6 }}>Expiry</span>
                <input type="date" value={vehicleForm.fitnessExpiry} onChange={(e) => setVehicleForm({ ...vehicleForm, fitnessExpiry: e.target.value })} />
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label>
                <input type="checkbox" checked={vehicleForm.isBlacklisted} onChange={(e) => setVehicleForm({ ...vehicleForm, isBlacklisted: e.target.checked })} /> Blacklisted
              </label>
              {vehicleForm.isBlacklisted && (
                <input placeholder="Blacklist Reason *" value={vehicleForm.blacklistReason} onChange={(e) => setVehicleForm({ ...vehicleForm, blacklistReason: e.target.value })} style={{ width: 300, marginLeft: 12 }} />
              )}
            </div>
            {vehicleFormError && <p style={{ color: 'crimson' }}>{vehicleFormError}</p>}
            <div>
              <button type="submit">Save Changes</button>
              <button type="button" onClick={resetVehicleForm} style={{ marginLeft: 8 }}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 24 }}>
        <div style={cardStyle}><strong>{vehicleStats.total}</strong><div>Total Vehicles</div></div>
        <div style={cardStyle}><strong>{vehicleStats.active}</strong><div>Active</div></div>
        <div style={cardStyle}><strong>{vehicleStats.inactive}</strong><div>Inactive</div></div>
        <div style={cardStyle}><strong style={{ color: vehicleStats.blacklisted ? 'crimson' : undefined }}>{vehicleStats.blacklisted}</strong><div>Blacklisted</div></div>
      </div>

      <h3 style={{ marginBottom: 8, cursor: 'pointer', userSelect: 'none' }} onClick={() => setShowVehicleList(!showVehicleList)}>
        {showVehicleList ? '▾' : '▸'} List of Vehicles
      </h3>

      {showVehicleList && (
        <>
          <input
            placeholder="Search by vehicle number, type, or segment..."
            value={vehicleSearch}
            onChange={(e) => setVehicleSearch(e.target.value)}
            style={{ width: '100%', padding: 8, marginBottom: 16, boxSizing: 'border-box' }}
          />
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 32 }}>
            <thead>
              <tr style={{ textAlign: 'center', borderBottom: '2px solid #ccc' }}>
                <th style={{ padding: 8 }}>Vehicle Number</th>
                <th style={{ padding: 8 }}>Type</th>
                <th style={{ padding: 8 }}>Max Capacity</th>
                <th style={{ padding: 8 }}>Blacklisted</th>
                <th style={{ padding: 8 }}>Status</th>
                <th style={{ padding: 8 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredVehicles.map((v) => (
                <tr key={v.id} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: 8, fontWeight: 'bold' }}>{v.vehicleNumber}</td>
                  <td style={{ padding: 8 }}>{v.vehicleType.name} ({v.vehicleType.segment})</td>
                  <td style={{ padding: 8 }}>{v.maxTonnage ?? v.vehicleType.maxTonnage} T</td>
                  <td style={{ padding: 8, color: v.isBlacklisted ? 'crimson' : undefined }}>{v.isBlacklisted ? `Yes — ${v.blacklistReason}` : 'No'}</td>
                  <td style={{ padding: 8 }}>{v.isActive ? 'Active' : 'Inactive'}</td>
                  <td style={{ padding: 8, whiteSpace: 'nowrap' }}>
                    <button onClick={() => startEditVehicle(v)}>Edit</button>
                    <button onClick={() => handleVehicleToggleActive(v)} style={{ marginLeft: 6 }}>
                      {v.isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                    <button onClick={() => handleVehicleDelete(v)} style={{ marginLeft: 6, color: 'crimson' }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredVehicles.length === 0 && <p style={{ marginTop: -16, marginBottom: 32 }}>No vehicles found.</p>}
        </>
      )}

      {/* ===================== Drivers ===================== */}
      <h2 style={{ marginTop: 32 }}>Drivers</h2>

      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 8 }}>
        <button onClick={handleDriverExport}>Export to Excel</button>
        <button onClick={handleDriverDeleteAll} style={{ color: 'crimson' }}>Delete All</button>
      </div>

      {driverDeleteAllResult && <p style={{ textAlign: 'center' }}>{driverDeleteAllResult}</p>}

      {editingDriverId && (
        <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>Edit Driver — {driverForm.name}</h3>
          <form onSubmit={handleDriverSubmit}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <input placeholder="Name *" value={driverForm.name} onChange={(e) => setDriverForm({ ...driverForm, name: e.target.value })} required style={{ width: 200 }} />
              <input placeholder="Phone" value={driverForm.phone} onChange={(e) => setDriverForm({ ...driverForm, phone: e.target.value })} style={{ width: 150 }} />
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12, alignItems: 'center' }}>
              <input placeholder="License Number" value={driverForm.licenseNumber} onChange={(e) => setDriverForm({ ...driverForm, licenseNumber: e.target.value })} style={{ width: 180 }} />
              <span style={{ fontSize: 12, color: '#666' }}>License Expiry</span>
              <input type="date" value={driverForm.licenseExpiry} onChange={(e) => setDriverForm({ ...driverForm, licenseExpiry: e.target.value })} style={{ width: 150 }} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label>
                <input type="checkbox" checked={driverForm.isBlacklisted} onChange={(e) => setDriverForm({ ...driverForm, isBlacklisted: e.target.checked })} /> Blacklisted
              </label>
              {driverForm.isBlacklisted && (
                <input placeholder="Blacklist Reason *" value={driverForm.blacklistReason} onChange={(e) => setDriverForm({ ...driverForm, blacklistReason: e.target.value })} style={{ width: 300, marginLeft: 12 }} />
              )}
            </div>
            {driverFormError && <p style={{ color: 'crimson' }}>{driverFormError}</p>}
            <div>
              <button type="submit">Save Changes</button>
              <button type="button" onClick={resetDriverForm} style={{ marginLeft: 8 }}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 24 }}>
        <div style={cardStyle}><strong>{driverStats.total}</strong><div>Total Drivers</div></div>
        <div style={cardStyle}><strong>{driverStats.active}</strong><div>Active</div></div>
        <div style={cardStyle}><strong>{driverStats.inactive}</strong><div>Inactive</div></div>
        <div style={cardStyle}><strong style={{ color: driverStats.blacklisted ? 'crimson' : undefined }}>{driverStats.blacklisted}</strong><div>Blacklisted</div></div>
      </div>

      <h3 style={{ marginBottom: 8, cursor: 'pointer', userSelect: 'none' }} onClick={() => setShowDriverList(!showDriverList)}>
        {showDriverList ? '▾' : '▸'} List of Drivers
      </h3>

      {showDriverList && (
        <>
          <input
            placeholder="Search by name, phone, or license number..."
            value={driverSearch}
            onChange={(e) => setDriverSearch(e.target.value)}
            style={{ width: '100%', padding: 8, marginBottom: 16, boxSizing: 'border-box' }}
          />
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'center', borderBottom: '2px solid #ccc' }}>
                <th style={{ padding: 8 }}>Name</th>
                <th style={{ padding: 8 }}>Phone</th>
                <th style={{ padding: 8 }}>License Number</th>
                <th style={{ padding: 8 }}>Blacklisted</th>
                <th style={{ padding: 8 }}>Status</th>
                <th style={{ padding: 8 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredDrivers.map((d) => (
                <tr key={d.id} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: 8, fontWeight: 'bold' }}>{d.name}</td>
                  <td style={{ padding: 8 }}>{d.phone || '—'}</td>
                  <td style={{ padding: 8 }}>{d.licenseNumber || '—'} {d.licenseExpiry ? `(exp. ${fmtDate(d.licenseExpiry)})` : ''}</td>
                  <td style={{ padding: 8, color: d.isBlacklisted ? 'crimson' : undefined }}>{d.isBlacklisted ? `Yes — ${d.blacklistReason}` : 'No'}</td>
                  <td style={{ padding: 8 }}>{d.isActive ? 'Active' : 'Inactive'}</td>
                  <td style={{ padding: 8, whiteSpace: 'nowrap' }}>
                    <button onClick={() => startEditDriver(d)}>Edit</button>
                    <button onClick={() => handleDriverToggleActive(d)} style={{ marginLeft: 6 }}>
                      {d.isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                    <button onClick={() => handleDriverDelete(d)} style={{ marginLeft: 6, color: 'crimson' }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredDrivers.length === 0 && <p style={{ marginTop: 16 }}>No drivers found.</p>}
        </>
      )}
    </div>
  );
}

export default VehicleDriverPage;

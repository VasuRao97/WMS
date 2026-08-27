import { useEffect, useState } from 'react';

// Dock Door master data page (2026-08-27, live-testing follow-up) — the
// first frontend DockDoor has ever had. Backend CRUD already existed
// (2026-08-25, Yard & Gate Management) but nothing called it. Built now
// specifically so "set the staging area against each dock" is actually
// usable, not just schema — see schema.prisma's comment on
// DockDoor.defaultStagingLocationId and InboundOrdersPage.tsx's Match
// Order modal, which pre-fills its staging dropdown from this data.
// Follows LocationsPage.tsx's "form doubles as edit form" convention, but
// (unlike Locations) DockDoor has no other creation entry point, so the
// form also handles plain create — closer to Warehouse/SKU's manual-add
// toggle, just with edit added on top.

type Warehouse = { id: string; code: string; name: string };
type Location = { id: string; code: string; warehouseId: string };
type DockDoor = {
  id: string;
  warehouseId: string;
  warehouse: Warehouse;
  code: string;
  name?: string;
  dockType: 'INBOUND' | 'OUTBOUND' | 'BOTH';
  status: 'AVAILABLE' | 'OCCUPIED' | 'MAINTENANCE';
  isActive: boolean;
  defaultStagingLocation?: { id: string; code: string };
};

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('token')}` };
}
function jsonHeaders() {
  return { 'Content-Type': 'application/json', ...authHeaders() };
}
function errorText(data: any, fallback: string) {
  return Array.isArray(data?.message) ? data.message.join(' | ') : data?.message || fallback;
}

const DOCK_TYPE_LABELS: Record<string, string> = { INBOUND: 'Inbound', OUTBOUND: 'Outbound', BOTH: 'Both' };
const STATUS_LABELS: Record<string, string> = { AVAILABLE: 'Available', OCCUPIED: 'Occupied', MAINTENANCE: 'Maintenance' };

const emptyForm = { warehouseId: '', code: '', name: '', dockType: 'BOTH', defaultStagingLocationId: '' };

function DockDoorsPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [dockDoors, setDockDoors] = useState<DockDoor[]>([]);
  const [search, setSearch] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState('');

  const load = () => {
    fetch('http://localhost:3000/warehouses', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setWarehouses(Array.isArray(d) ? d : []));
    fetch('http://localhost:3000/locations', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setLocations(Array.isArray(d) ? d : []));
    fetch('http://localhost:3000/dock-doors', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setDockDoors(Array.isArray(d) ? d : []));
  };
  useEffect(() => { load(); }, []);

  const locationsForWarehouse = locations.filter((l) => l.warehouseId === form.warehouseId);

  const resetForm = () => {
    setForm(emptyForm);
    setEditingId(null);
    setFormError('');
    setShowForm(false);
  };
  const startEdit = (d: DockDoor) => {
    setEditingId(d.id);
    setForm({
      warehouseId: d.warehouseId,
      code: d.code,
      name: d.name || '',
      dockType: d.dockType,
      defaultStagingLocationId: d.defaultStagingLocation?.id || '',
    });
    setFormError('');
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    const body: any = { code: form.code, name: form.name || undefined, dockType: form.dockType, defaultStagingLocationId: form.defaultStagingLocationId || null };
    const url = editingId ? `http://localhost:3000/dock-doors/${editingId}` : 'http://localhost:3000/dock-doors';
    if (!editingId) body.warehouseId = form.warehouseId;
    const res = await fetch(url, { method: editingId ? 'PATCH' : 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) {
      setFormError(errorText(data, 'Could not save this dock door.'));
      return;
    }
    resetForm();
    load();
  };

  const handleStatusChange = async (id: string, status: string) => {
    const res = await fetch(`http://localhost:3000/dock-doors/${id}/status`, { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ status }) });
    if (!res.ok) {
      const data = await res.json();
      alert(errorText(data, 'Could not update status.'));
      return;
    }
    load();
  };

  const handleDeactivate = async (id: string, isActive: boolean) => {
    const action = isActive ? 'deactivate' : 'reactivate';
    await fetch(`http://localhost:3000/dock-doors/${id}/${action}`, { method: 'PATCH', headers: authHeaders() });
    load();
  };

  const handleDelete = async (id: string, code: string) => {
    if (!confirm(`Permanently delete dock door ${code}? This cannot be undone.`)) return;
    const res = await fetch(`http://localhost:3000/dock-doors/${id}`, { method: 'DELETE', headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) {
      alert(errorText(data, 'Could not delete this dock door.'));
      return;
    }
    load();
  };

  const filtered = dockDoors.filter((d) => {
    const q = search.toLowerCase();
    return !q || d.code.toLowerCase().includes(q) || (d.name || '').toLowerCase().includes(q) || d.warehouse.code.toLowerCase().includes(q);
  });

  return (
    <div style={{ maxWidth: 1000, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1 style={{ textAlign: 'center' }}>Dock Doors</h1>
      <p style={{ textAlign: 'center', color: '#666', marginTop: -8 }}>
        Physical dock doors, their occupancy status, and each dock's own default staging spot — pre-filled
        automatically at Match Order once a vehicle's assigned dock matches one of these codes.
      </p>

      <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'center' }}>
        <button type="button" onClick={() => (showForm ? resetForm() : setShowForm(true))}>
          {showForm ? '▾ Hide form' : '▸ + Add Dock Door'}
        </button>
      </div>

      {showForm && (
        <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>{editingId ? 'Edit Dock Door' : 'New Dock Door'}</h3>
          <form onSubmit={handleSubmit}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <select value={form.warehouseId} onChange={(e) => setForm({ ...form, warehouseId: e.target.value })} required disabled={!!editingId} style={{ width: 220 }}>
                <option value="">Warehouse *</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
                ))}
              </select>
              <input placeholder="Code *" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required style={{ width: 120 }} />
              <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ width: 180 }} />
              <select value={form.dockType} onChange={(e) => setForm({ ...form, dockType: e.target.value })} style={{ width: 140 }}>
                {Object.entries(DOCK_TYPE_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <label style={{ display: 'block', fontSize: 13, color: '#666', marginBottom: 4 }}>
              Default Staging Location — where an Inbound delivery at this dock normally gets unloaded to (optional; still overridable at Match Order)
            </label>
            <select
              value={form.defaultStagingLocationId}
              onChange={(e) => setForm({ ...form, defaultStagingLocationId: e.target.value })}
              disabled={!form.warehouseId}
              style={{ width: '100%', marginBottom: 12, boxSizing: 'border-box', padding: 8 }}
            >
              <option value="">None</option>
              {locationsForWarehouse.map((l) => (
                <option key={l.id} value={l.id}>{l.code}</option>
              ))}
            </select>
            {formError && <p style={{ color: 'crimson' }}>{formError}</p>}
            <div>
              <button type="submit">{editingId ? 'Save Changes' : 'Create Dock Door'}</button>
              <button type="button" onClick={resetForm} style={{ marginLeft: 8 }}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center' }}>
        <input placeholder="Search code, name, warehouse..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 320, padding: 8 }} />
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'center', borderBottom: '2px solid #ccc' }}>
            <th style={{ padding: 8 }}>Warehouse</th>
            <th style={{ padding: 8 }}>Code</th>
            <th style={{ padding: 8 }}>Name</th>
            <th style={{ padding: 8 }}>Type</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8 }}>Default Staging</th>
            <th style={{ padding: 8 }}>Active</th>
            <th style={{ padding: 8 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((d) => (
            <tr key={d.id} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
              <td style={{ padding: 8 }}>{d.warehouse.code}</td>
              <td style={{ padding: 8, fontWeight: 'bold' }}>{d.code}</td>
              <td style={{ padding: 8 }}>{d.name || '—'}</td>
              <td style={{ padding: 8 }}>{DOCK_TYPE_LABELS[d.dockType] || d.dockType}</td>
              <td style={{ padding: 8 }}>
                <select value={d.status} onChange={(e) => handleStatusChange(d.id, e.target.value)}>
                  {Object.entries(STATUS_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </td>
              <td style={{ padding: 8 }}>{d.defaultStagingLocation?.code || '—'}</td>
              <td style={{ padding: 8 }}>{d.isActive ? 'Active' : 'Inactive'}</td>
              <td style={{ padding: 8, whiteSpace: 'nowrap' }}>
                <button onClick={() => startEdit(d)}>Edit</button>
                <button onClick={() => handleDeactivate(d.id, d.isActive)} style={{ marginLeft: 6 }}>{d.isActive ? 'Deactivate' : 'Reactivate'}</button>
                <button onClick={() => handleDelete(d.id, d.code)} style={{ marginLeft: 6, color: 'crimson' }}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {filtered.length === 0 && <p style={{ textAlign: 'center' }}>No dock doors found.</p>}
    </div>
  );
}

export default DockDoorsPage;

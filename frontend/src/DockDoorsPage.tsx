import { useEffect, useState } from 'react';

// Dock Door master data page (2026-08-27, live-testing follow-up) — the
// first frontend DockDoor has ever had. Backend CRUD already existed
// (2026-08-25, Yard & Gate Management) but nothing called it. Built now
// specifically so "set the staging area against each dock" is actually
// usable, not just schema — see schema.prisma's comment on
// DockDoor.defaultStagingLocationId and InboundOrdersPage.tsx's Match
// Order modal, which pre-fills its staging dropdown from this data.
//
// 2026-08-28 (Putaway kickoff conversation) — manual creation was REMOVED
// from this page entirely, per the client's own explicit call: "i want you
// to automatically make 1 location for inbound and 1 location for outbound
// for every dock yourself... i dont want the client doing this activity at
// all." Warehouse.noOfDocks now drives WarehousesService.
// generateDockDoorsAndStaging(), which creates every Dock Door and its
// Inbound ("Dock{N}-SA-IB") / Outbound ("Dock{N}-SA-OB") staging Location
// pair automatically at Warehouse creation. This page is now purely a
// browse/edit/delete surface, same "generator/import creates, this page
// only edits" pattern LocationsPage.tsx already established for manually
// removing its own "Add Location" entry point.

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
  outboundStagingLocation?: { id: string; code: string };
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

const emptyForm = { code: '', name: '', dockType: 'BOTH', defaultStagingLocationId: '', outboundStagingLocationId: '' };

function DockDoorsPage() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [dockDoors, setDockDoors] = useState<DockDoor[]>([]);
  const [search, setSearch] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingWarehouseId, setEditingWarehouseId] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState('');

  const load = () => {
    fetch('http://localhost:3000/locations', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setLocations(Array.isArray(d) ? d : []));
    fetch('http://localhost:3000/dock-doors', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setDockDoors(Array.isArray(d) ? d : []));
  };
  useEffect(() => { load(); }, []);

  const locationsForWarehouse = locations.filter((l) => l.warehouseId === editingWarehouseId);

  const resetForm = () => {
    setForm(emptyForm);
    setEditingId(null);
    setEditingWarehouseId('');
    setFormError('');
  };
  const startEdit = (d: DockDoor) => {
    setEditingId(d.id);
    setEditingWarehouseId(d.warehouseId);
    setForm({
      code: d.code,
      name: d.name || '',
      dockType: d.dockType,
      defaultStagingLocationId: d.defaultStagingLocation?.id || '',
      outboundStagingLocationId: d.outboundStagingLocation?.id || '',
    });
    setFormError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingId) return;
    setFormError('');
    const body: any = {
      code: form.code,
      name: form.name || undefined,
      dockType: form.dockType,
      defaultStagingLocationId: form.defaultStagingLocationId || null,
      outboundStagingLocationId: form.outboundStagingLocationId || null,
    };
    const res = await fetch(`http://localhost:3000/dock-doors/${editingId}`, { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(body) });
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
        Auto-generated from each Warehouse's "No of Docks" — one Dock Door plus its own Inbound and Outbound
        staging bin per dock, created automatically the moment a warehouse is set up. Nothing to add here
        manually; edit or delete a dock below if reality doesn't match what was auto-created. Status
        auto-flips to Occupied while a vehicle is docked in and Available once it gates out — a dock is
        locked (no edit/status/deactivate/delete) for as long as it's Occupied.
      </p>

      {editingId && (
        <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>Edit Dock Door</h3>
          <form onSubmit={handleSubmit}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <input placeholder="Code *" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required style={{ width: 120 }} />
              <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ width: 180 }} />
              <select value={form.dockType} onChange={(e) => setForm({ ...form, dockType: e.target.value })} style={{ width: 140 }}>
                {Object.entries(DOCK_TYPE_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <label style={{ display: 'block', fontSize: 13, color: '#666', marginBottom: 4 }}>
              Inbound Staging Location — where a delivery at this dock gets unloaded to (still overridable at Match Order)
            </label>
            <select
              value={form.defaultStagingLocationId}
              onChange={(e) => setForm({ ...form, defaultStagingLocationId: e.target.value })}
              style={{ width: '100%', marginBottom: 12, boxSizing: 'border-box', padding: 8 }}
            >
              <option value="">None</option>
              {locationsForWarehouse.map((l) => (
                <option key={l.id} value={l.id}>{l.code}</option>
              ))}
            </select>
            <label style={{ display: 'block', fontSize: 13, color: '#666', marginBottom: 4 }}>
              Outbound Staging Location — where a load-out at this dock gets staged from
            </label>
            <select
              value={form.outboundStagingLocationId}
              onChange={(e) => setForm({ ...form, outboundStagingLocationId: e.target.value })}
              style={{ width: '100%', marginBottom: 12, boxSizing: 'border-box', padding: 8 }}
            >
              <option value="">None</option>
              {locationsForWarehouse.map((l) => (
                <option key={l.id} value={l.id}>{l.code}</option>
              ))}
            </select>
            <p style={{ fontSize: 12, color: '#888', marginTop: -6 }}>
              Only one of a dock's Inbound/Outbound staging bins can be in use at a time — the system blocks
              matching an order to one while the other still has real stock in it.
            </p>
            {formError && <p style={{ color: 'crimson' }}>{formError}</p>}
            <div>
              <button type="submit">Save Changes</button>
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
            <th style={{ padding: 8 }}>Inbound Staging</th>
            <th style={{ padding: 8 }}>Outbound Staging</th>
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
                <select value={d.status} onChange={(e) => handleStatusChange(d.id, e.target.value)} disabled={d.status === 'OCCUPIED'}>
                  {Object.entries(STATUS_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </td>
              <td style={{ padding: 8 }}>{d.defaultStagingLocation?.code || '—'}</td>
              <td style={{ padding: 8 }}>{d.outboundStagingLocation?.code || '—'}</td>
              <td style={{ padding: 8 }}>{d.isActive ? 'Active' : 'Inactive'}</td>
              <td style={{ padding: 8, whiteSpace: 'nowrap' }}>
                {d.status === 'OCCUPIED' ? (
                  <span style={{ color: '#888', fontSize: 12 }} title="Locked while a vehicle is docked in — available again after Gate Out.">
                    Locked (occupied)
                  </span>
                ) : (
                  <>
                    <button onClick={() => startEdit(d)}>Edit</button>
                    <button onClick={() => handleDeactivate(d.id, d.isActive)} style={{ marginLeft: 6 }}>{d.isActive ? 'Deactivate' : 'Reactivate'}</button>
                    <button onClick={() => handleDelete(d.id, d.code)} style={{ marginLeft: 6, color: 'crimson' }}>Delete</button>
                  </>
                )}
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

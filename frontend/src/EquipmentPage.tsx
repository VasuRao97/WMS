import { useEffect, useState } from 'react';

// MHE (Material Handling Equipment) master (2026-08-28, Putaway kickoff
// conversation) — built before any Putaway task logic, per the client's own
// explicit sequencing: "we need to get the MHE master at start, and work
// accordingly, the throughput of each mhe would be different." Same
// two-tier shape as Vehicle/VehicleType: EquipmentType is platform-seeded
// reference data (read-only here, see prisma/seed.ts), Equipment is a
// company's own warehouse-scoped registered unit that can override the
// type's generic throughput numbers. Unlike DockDoorsPage.tsx (auto-
// generated, edit-only), Equipment has no generator — a company just tells
// us what it owns, so this page keeps a manual "Add Equipment" form,
// collapsed behind a toggle same as every other master-data page's manual
// entry (see CLAUDE.md's frontend conventions).
//
// The activity-suitability matrix (added same day, then corrected) lives
// per WAREHOUSE, not on EquipmentType itself — a first pass put it on
// EquipmentType as one shared platform-wide classification with no way to
// actually edit it ("where is the matrix for input??"). The client's own
// call: "it should be warehouse wise! you can give dropdown for wh code and
// give matrix" — this page's "Equipment Type Matrix" section below is that
// real input surface, warehouse-selected via dropdown.

type Suitability = 'PRIMARY' | 'SECONDARY' | 'NOT_USED';
type Warehouse = { id: string; code: string; name: string };
type EquipmentType = {
  id: string;
  name: string;
  genericPalletsPerTrip: number;
  genericAvgTripMinutes: number;
  genericLoadedSpeedKmh?: number;
  genericUnloadedSpeedKmh?: number;
};
type MatrixRow = {
  equipmentTypeId: string;
  equipmentTypeName: string;
  putawaySuitability: Suitability;
  pickingSuitability: Suitability;
  loadingSuitability: Suitability;
  unloadingSuitability: Suitability;
  consolidationSuitability: Suitability;
  inventoryCheckSuitability: Suitability;
};
type Equipment = {
  id: string;
  warehouseId: string;
  warehouse: Warehouse;
  code: string;
  name?: string;
  equipmentType: EquipmentType;
  palletsPerTrip?: number;
  avgTripMinutes?: number;
  loadedSpeedKmh?: number;
  unloadedSpeedKmh?: number;
  isActive: boolean;
};

// Activity list — value matches the query param GET /equipment?activity=
// and the PATCH /equipment/suitability-matrix row field expects.
const ACTIVITIES: { value: string; label: string; field: keyof Omit<MatrixRow, 'equipmentTypeId' | 'equipmentTypeName'> }[] = [
  { value: 'PUTAWAY', label: 'Putaway', field: 'putawaySuitability' },
  { value: 'PICKING', label: 'Picking', field: 'pickingSuitability' },
  { value: 'LOADING', label: 'Loading', field: 'loadingSuitability' },
  { value: 'UNLOADING', label: 'Unloading', field: 'unloadingSuitability' },
  { value: 'CONSOLIDATION', label: 'Consolidation', field: 'consolidationSuitability' },
  { value: 'INVENTORY_CHECK', label: 'Inventory Check', field: 'inventoryCheckSuitability' },
];
const SUITABILITY_LABELS: Record<Suitability, string> = { PRIMARY: 'Primary', SECONDARY: 'Secondary', NOT_USED: 'Not used' };

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('token')}` };
}
function jsonHeaders() {
  return { 'Content-Type': 'application/json', ...authHeaders() };
}
function errorText(data: any, fallback: string) {
  return Array.isArray(data?.message) ? data.message.join(' | ') : data?.message || fallback;
}

const emptyForm = { warehouseId: '', code: '', name: '', equipmentTypeId: '', palletsPerTrip: '', avgTripMinutes: '', loadedSpeedKmh: '', unloadedSpeedKmh: '' };

function EquipmentPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [equipmentTypes, setEquipmentTypes] = useState<EquipmentType[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [search, setSearch] = useState('');
  const [deleteAllResult, setDeleteAllResult] = useState('');

  // "So we get all the mhe's in warehouse instantly" (2026-08-28) — narrows
  // the list to units actively usable (Primary/Secondary) for one activity
  // in one warehouse, via GET /equipment's optional query params. Activity
  // requires a warehouse (the matrix is scored per warehouse) — enforced
  // here by clearing/disabling Activity whenever no warehouse is picked.
  const [filterWarehouseId, setFilterWarehouseId] = useState('');
  const [filterActivity, setFilterActivity] = useState('');
  // The selected filter warehouse's own matrix, used only to render the
  // "Suitable For" column contextually — not fetched/shown when browsing
  // "All warehouses" (there's no single matrix to show across many).
  const [filterMatrix, setFilterMatrix] = useState<Record<string, MatrixRow> | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState('');

  // The real matrix INPUT surface (2026-08-28 correction) — pick a
  // warehouse, see/edit all 9 equipment types × 6 activities, Save.
  const [showMatrix, setShowMatrix] = useState(false);
  const [matrixWarehouseId, setMatrixWarehouseId] = useState('');
  const [matrixRows, setMatrixRows] = useState<MatrixRow[]>([]);
  const [matrixMsg, setMatrixMsg] = useState('');
  const [matrixSaving, setMatrixSaving] = useState(false);

  const loadEquipment = () => {
    const params = new URLSearchParams();
    if (filterWarehouseId) params.set('warehouseId', filterWarehouseId);
    if (filterWarehouseId && filterActivity) params.set('activity', filterActivity);
    const qs = params.toString();
    fetch(`http://localhost:3000/equipment${qs ? `?${qs}` : ''}`, { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setEquipment(Array.isArray(d) ? d : []));
  };
  const load = () => {
    fetch('http://localhost:3000/warehouses', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setWarehouses(Array.isArray(d) ? d : []));
    fetch('http://localhost:3000/equipment-types', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setEquipmentTypes(Array.isArray(d) ? d : []));
    loadEquipment();
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { loadEquipment(); }, [filterWarehouseId, filterActivity]);

  // Fetches the filter warehouse's own matrix purely for the "Suitable For"
  // column's display — independent of the matrix EDITOR's own state below.
  useEffect(() => {
    if (!filterWarehouseId) { setFilterMatrix(null); return; }
    fetch(`http://localhost:3000/equipment/suitability-matrix?warehouseId=${filterWarehouseId}`, { headers: authHeaders() })
      .then((r) => (r.status === 401 ? [] : r.json()))
      .then((d: MatrixRow[]) => setFilterMatrix(Object.fromEntries((Array.isArray(d) ? d : []).map((r) => [r.equipmentTypeId, r]))));
  }, [filterWarehouseId]);

  const loadMatrix = (warehouseId: string) => {
    if (!warehouseId) { setMatrixRows([]); return; }
    fetch(`http://localhost:3000/equipment/suitability-matrix?warehouseId=${warehouseId}`, { headers: authHeaders() })
      .then((r) => (r.status === 401 ? [] : r.json()))
      .then((d) => setMatrixRows(Array.isArray(d) ? d : []));
  };
  useEffect(() => { setMatrixMsg(''); loadMatrix(matrixWarehouseId); }, [matrixWarehouseId]);

  const handleMatrixCellChange = (equipmentTypeId: string, field: string, value: Suitability) => {
    setMatrixRows((rows) => rows.map((r) => (r.equipmentTypeId === equipmentTypeId ? { ...r, [field]: value } : r)));
  };

  const handleMatrixSave = async () => {
    setMatrixSaving(true);
    setMatrixMsg('');
    const res = await fetch('http://localhost:3000/equipment/suitability-matrix', {
      method: 'PATCH', headers: jsonHeaders(),
      body: JSON.stringify({ warehouseId: matrixWarehouseId, rows: matrixRows }),
    });
    const data = await res.json();
    setMatrixSaving(false);
    if (!res.ok) {
      setMatrixMsg(`Could not save: ${errorText(data, 'Unknown error.')}`);
      return;
    }
    setMatrixRows(data);
    setMatrixMsg('Saved.');
    if (filterWarehouseId === matrixWarehouseId) setFilterMatrix(Object.fromEntries(data.map((r: MatrixRow) => [r.equipmentTypeId, r])));
  };

  const selectedType = equipmentTypes.find((t) => t.id === form.equipmentTypeId);

  const resetForm = () => {
    setForm(emptyForm);
    setEditingId(null);
    setFormError('');
    setShowForm(false);
  };
  const startEdit = (e: Equipment) => {
    setEditingId(e.id);
    setForm({
      warehouseId: e.warehouseId,
      code: e.code,
      name: e.name || '',
      equipmentTypeId: e.equipmentType.id,
      palletsPerTrip: e.palletsPerTrip !== undefined && e.palletsPerTrip !== null ? String(e.palletsPerTrip) : '',
      avgTripMinutes: e.avgTripMinutes !== undefined && e.avgTripMinutes !== null ? String(e.avgTripMinutes) : '',
      loadedSpeedKmh: e.loadedSpeedKmh !== undefined && e.loadedSpeedKmh !== null ? String(e.loadedSpeedKmh) : '',
      unloadedSpeedKmh: e.unloadedSpeedKmh !== undefined && e.unloadedSpeedKmh !== null ? String(e.unloadedSpeedKmh) : '',
    });
    setFormError('');
    setShowForm(true);
  };

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError('');
    const body: any = {
      warehouseId: form.warehouseId,
      code: form.code,
      name: form.name || undefined,
      equipmentTypeId: form.equipmentTypeId,
      palletsPerTrip: form.palletsPerTrip || undefined,
      avgTripMinutes: form.avgTripMinutes || undefined,
      loadedSpeedKmh: form.loadedSpeedKmh || undefined,
      unloadedSpeedKmh: form.unloadedSpeedKmh || undefined,
    };
    const url = editingId ? `http://localhost:3000/equipment/${editingId}` : 'http://localhost:3000/equipment';
    const res = await fetch(url, { method: editingId ? 'PATCH' : 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) {
      setFormError(errorText(data, 'Could not save this equipment.'));
      return;
    }
    resetForm();
    load();
  };

  const handleDeactivate = async (id: string, isActive: boolean) => {
    const action = isActive ? 'deactivate' : 'reactivate';
    await fetch(`http://localhost:3000/equipment/${id}/${action}`, { method: 'PATCH', headers: authHeaders() });
    load();
  };

  const handleDelete = async (id: string, code: string) => {
    if (!confirm(`Permanently delete equipment ${code}? This cannot be undone.`)) return;
    const res = await fetch(`http://localhost:3000/equipment/${id}`, { method: 'DELETE', headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) {
      alert(errorText(data, 'Could not delete this equipment.'));
      return;
    }
    load();
  };

  const handleDeleteAll = async () => {
    if (!confirm('Permanently delete ALL equipment? This cannot be undone.')) return;
    const res = await fetch('http://localhost:3000/equipment/all', { method: 'DELETE', headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) {
      setDeleteAllResult(`Delete All failed: ${errorText(data, 'Unknown error.')}`);
      return;
    }
    setDeleteAllResult(`Deleted ${data.deletedCount} equipment unit(s).`);
    load();
  };

  const filtered = equipment.filter((e) => {
    const q = search.toLowerCase();
    return !q || e.code.toLowerCase().includes(q) || (e.name || '').toLowerCase().includes(q) || e.equipmentType.name.toLowerCase().includes(q) || e.warehouse.code.toLowerCase().includes(q);
  });

  return (
    <div style={{ maxWidth: 1100, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1 style={{ textAlign: 'center' }}>Equipment (MHE)</h1>
      <p style={{ textAlign: 'center', color: '#666', marginTop: -8 }}>
        Material Handling Equipment master — forklifts, reach trucks, pallet trucks, trolleys, etc. Register what
        each warehouse actually owns; a unit can override its Equipment Type's generic pallets-per-trip/avg-trip-time
        with its own real numbers. This is foundation data for Putaway, built ahead of Putaway's own task logic.
      </p>

      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={handleDeleteAll} style={{ color: 'crimson' }}>Delete All</button>
        {!editingId && (
          <button type="button" onClick={() => setShowForm(!showForm)}>
            {showForm ? '▾ Hide manual entry' : '▸ Add Equipment manually'}
          </button>
        )}
        <button type="button" onClick={() => setShowMatrix(!showMatrix)}>
          {showMatrix ? '▾ Hide Equipment Type Matrix' : '▸ Configure Equipment Type Matrix'}
        </button>
      </div>

      {deleteAllResult && <p style={{ textAlign: 'center' }}>{deleteAllResult}</p>}

      {showMatrix && (
        <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>Equipment Type Matrix</h3>
          <p style={{ fontSize: 13, color: '#666', marginTop: -8 }}>
            Which equipment types are usable for each activity — set per warehouse, since real practice can differ
            warehouse to warehouse. A new warehouse starts with a reasonable default; correct it here.
          </p>
          <select value={matrixWarehouseId} onChange={(e) => setMatrixWarehouseId(e.target.value)} style={{ width: 200, marginBottom: 12, padding: 6 }}>
            <option value="">Select a warehouse…</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.code}</option>
            ))}
          </select>
          {matrixWarehouseId && matrixRows.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'center', borderBottom: '2px solid #ccc' }}>
                    <th style={{ padding: 8, textAlign: 'left' }}>Equipment Type</th>
                    {ACTIVITIES.map((a) => (
                      <th key={a.value} style={{ padding: 8 }}>{a.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrixRows.map((row) => (
                    <tr key={row.equipmentTypeId} style={{ borderBottom: '1px solid #eee' }}>
                      <td style={{ padding: 8 }}>{row.equipmentTypeName}</td>
                      {ACTIVITIES.map((a) => (
                        <td key={a.value} style={{ padding: 8, textAlign: 'center' }}>
                          <select
                            value={row[a.field]}
                            onChange={(e) => handleMatrixCellChange(row.equipmentTypeId, a.field, e.target.value as Suitability)}
                            style={{ width: 120 }}
                          >
                            {(['PRIMARY', 'SECONDARY', 'NOT_USED'] as Suitability[]).map((v) => (
                              <option key={v} value={v}>{SUITABILITY_LABELS[v]}</option>
                            ))}
                          </select>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: 12 }}>
                <button onClick={handleMatrixSave} disabled={matrixSaving}>{matrixSaving ? 'Saving…' : 'Save Matrix'}</button>
                {matrixMsg && <span style={{ marginLeft: 12, color: matrixMsg.startsWith('Could not') ? 'crimson' : 'green' }}>{matrixMsg}</span>}
              </div>
            </div>
          )}
        </div>
      )}

      {showForm && (
        <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>{editingId ? 'Edit Equipment' : 'Add Equipment'}</h3>
          <form onSubmit={handleSubmit}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <select value={form.warehouseId} onChange={(e) => setForm({ ...form, warehouseId: e.target.value })} required disabled={!!editingId} style={{ width: 180 }}>
                <option value="">Warehouse *</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>{w.code}</option>
                ))}
              </select>
              <input placeholder="Code *" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required style={{ width: 120 }} />
              <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ width: 180 }} />
              <select value={form.equipmentTypeId} onChange={(e) => setForm({ ...form, equipmentTypeId: e.target.value })} required style={{ width: 260 }}>
                <option value="">Equipment Type *</option>
                {equipmentTypes.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12, alignItems: 'center' }}>
              <input
                type="number" step="0.01" placeholder="Pallets/Trip override"
                value={form.palletsPerTrip} onChange={(e) => setForm({ ...form, palletsPerTrip: e.target.value })} style={{ width: 180 }}
              />
              <input
                type="number" step="0.1" placeholder="Avg Trip Minutes override"
                value={form.avgTripMinutes} onChange={(e) => setForm({ ...form, avgTripMinutes: e.target.value })} style={{ width: 200 }}
              />
              {selectedType && (
                <span style={{ fontSize: 12, color: '#888' }}>
                  Leave blank to use {selectedType.name}'s generic values ({Number(selectedType.genericPalletsPerTrip)} pallets/trip, {Number(selectedType.genericAvgTripMinutes)} min/trip).
                </span>
              )}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12, alignItems: 'center' }}>
              <input
                type="number" step="0.1" placeholder="Loaded Speed override (km/h)"
                value={form.loadedSpeedKmh} onChange={(e) => setForm({ ...form, loadedSpeedKmh: e.target.value })} style={{ width: 210 }}
              />
              <input
                type="number" step="0.1" placeholder="Unloaded Speed override (km/h)"
                value={form.unloadedSpeedKmh} onChange={(e) => setForm({ ...form, unloadedSpeedKmh: e.target.value })} style={{ width: 220 }}
              />
              {selectedType && (
                <span style={{ fontSize: 12, color: '#888' }}>
                  {selectedType.genericLoadedSpeedKmh != null
                    ? `Leave blank to use the generic ${Number(selectedType.genericLoadedSpeedKmh)} km/h loaded / ${Number(selectedType.genericUnloadedSpeedKmh)} km/h unloaded.`
                    : 'No generic speed set yet for this type — real figures pending.'}
                </span>
              )}
            </div>
            {formError && <p style={{ color: 'crimson' }}>{formError}</p>}
            <div>
              <button type="submit">{editingId ? 'Save Changes' : 'Add Equipment'}</button>
              <button type="button" onClick={resetForm} style={{ marginLeft: 8 }}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 13, color: '#666' }}>Show equipment usable for:</span>
        <select
          value={filterActivity}
          onChange={(e) => setFilterActivity(e.target.value)}
          disabled={!filterWarehouseId}
          title={!filterWarehouseId ? 'Pick a warehouse first — the matrix is scored per warehouse.' : undefined}
          style={{ width: 180 }}
        >
          <option value="">Any (all equipment)</option>
          {ACTIVITIES.map((a) => (
            <option key={a.value} value={a.value}>{a.label}</option>
          ))}
        </select>
        <select value={filterWarehouseId} onChange={(e) => { setFilterWarehouseId(e.target.value); if (!e.target.value) setFilterActivity(''); }} style={{ width: 160 }}>
          <option value="">All warehouses</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>{w.code}</option>
          ))}
        </select>
      </div>
      {!filterWarehouseId && (
        <p style={{ textAlign: 'center', fontSize: 12, color: '#888', marginTop: 0 }}>
          Pick a warehouse to filter by activity or see each unit's Suitable For rating.
        </p>
      )}
      {filterActivity && (
        <p style={{ textAlign: 'center', fontSize: 12, color: '#888', marginTop: 0 }}>
          Only active equipment whose type is rated Primary or Secondary for {ACTIVITIES.find((a) => a.value === filterActivity)?.label} in this warehouse — Primary-rated first.
        </p>
      )}

      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center' }}>
        <input placeholder="Search code, name, type, warehouse..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 320, padding: 8 }} />
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'center', borderBottom: '2px solid #ccc' }}>
            <th style={{ padding: 8 }}>Warehouse</th>
            <th style={{ padding: 8 }}>Code</th>
            <th style={{ padding: 8 }}>Name</th>
            <th style={{ padding: 8 }}>Equipment Type</th>
            <th style={{ padding: 8 }}>Pallets/Trip</th>
            <th style={{ padding: 8 }}>Avg Trip Min</th>
            <th style={{ padding: 8 }}>Suitable For (this warehouse)</th>
            <th style={{ padding: 8 }}>Active</th>
            <th style={{ padding: 8 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((e) => {
            const pallets = e.palletsPerTrip ?? e.equipmentType.genericPalletsPerTrip;
            const minutes = e.avgTripMinutes ?? e.equipmentType.genericAvgTripMinutes;
            const matrixRow = filterWarehouseId === e.warehouseId ? filterMatrix?.[e.equipmentType.id] : undefined;
            return (
              <tr key={e.id} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
                <td style={{ padding: 8 }}>{e.warehouse.code}</td>
                <td style={{ padding: 8, fontWeight: 'bold' }}>{e.code}</td>
                <td style={{ padding: 8 }}>{e.name || '—'}</td>
                <td style={{ padding: 8 }}>{e.equipmentType.name}</td>
                <td style={{ padding: 8 }} title={e.palletsPerTrip == null ? 'Generic (type default)' : 'Overridden'}>
                  {Number(pallets)}{e.palletsPerTrip == null && <span style={{ color: '#aaa' }}> (generic)</span>}
                </td>
                <td style={{ padding: 8 }} title={e.avgTripMinutes == null ? 'Generic (type default)' : 'Overridden'}>
                  {Number(minutes)}{e.avgTripMinutes == null && <span style={{ color: '#aaa' }}> (generic)</span>}
                </td>
                <td style={{ padding: 8, fontSize: 12, textAlign: 'left' }}>
                  {matrixRow ? (
                    ACTIVITIES.filter((a) => matrixRow[a.field] !== 'NOT_USED')
                      .map((a) => `${a.label} (${SUITABILITY_LABELS[matrixRow[a.field]]})`)
                      .join(', ') || <span style={{ color: '#aaa' }}>Not used for any activity</span>
                  ) : (
                    <span style={{ color: '#aaa' }}>Filter by this warehouse to see</span>
                  )}
                </td>
                <td style={{ padding: 8 }}>{e.isActive ? 'Active' : 'Inactive'}</td>
                <td style={{ padding: 8, whiteSpace: 'nowrap' }}>
                  <button onClick={() => startEdit(e)}>Edit</button>
                  <button onClick={() => handleDeactivate(e.id, e.isActive)} style={{ marginLeft: 6 }}>{e.isActive ? 'Deactivate' : 'Reactivate'}</button>
                  <button onClick={() => handleDelete(e.id, e.code)} style={{ marginLeft: 6, color: 'crimson' }}>Delete</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {filtered.length === 0 && <p style={{ textAlign: 'center' }}>No equipment found.</p>}
    </div>
  );
}

export default EquipmentPage;

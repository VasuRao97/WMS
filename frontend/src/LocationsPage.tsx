import { useEffect, useState } from 'react';
import LocationsPlanView from './LocationsPlanView';

export type ProductCategory = { id: string; name: string };
export type Warehouse = { id: string; code: string; name: string };

export type Location = {
  id: string;
  warehouseId: string;
  warehouse: { id: string; code: string; name: string };
  code: string;
  zone?: string;
  section?: string;
  zoneType: string;
  storageType: string;
  category?: { id: string; name: string };
  aisle?: string;
  rack?: string;
  level?: string;
  bin?: string;
  block?: string;
  stack?: string;
  flankNumber?: number;
  depth?: number;
  width?: number;
  height?: number;
  capacity?: number;
  isActive: boolean;
};

type RowResult = { id?: string; code?: string; status: 'success' | 'error'; errors?: string[] };
type BatchSummary = { totalRequested?: number; totalRows?: number; successCount: number; failCount: number; results: RowResult[] };

// Zone Type = what a bin is FOR. Same 14-value list as LocationZoneType in
// schema.prisma — see CLAUDE.md's Locations/Bins design-pass notes.
export const ZONE_TYPE_OPTIONS = [
  { value: 'UNLOADING_STAGING', label: 'Unloading Staging' },
  { value: 'LOADING_STAGING', label: 'Loading Staging' },
  { value: 'ACTUAL_STORAGE', label: 'Actual Storage' },
  { value: 'FORWARD_PICK', label: 'Forward Pick Zone' },
  { value: 'PICK_FACE', label: 'Pick Face' },
  { value: 'PACKING_KITTING', label: 'Packing/Kitting' },
  { value: 'CROSS_DOCK', label: 'Cross-Dock' },
  { value: 'SLOB', label: 'SLOB' },
  { value: 'RETURNS', label: 'Returns' },
  { value: 'RE_PUTAWAY', label: 'Re-Putaway' },
  { value: 'QC_HOLD', label: 'QC Hold' },
  { value: 'TEMP_CONTROLLED_STORAGE', label: 'Temp-Controlled Storage' },
  { value: 'HAZMAT', label: 'Hazmat' },
  { value: 'DAMAGE_SCRAP', label: 'Damage & Scrap' },
];

// Storage Type = how a bin is physically built. No "Mix" here on purpose —
// that value only ever means "warehouse hasn't broken this down yet" at the
// WarehouseStorageType (capacity-planning) level; a real bin is always
// concretely one of these five.
export const STORAGE_TYPE_OPTIONS = [
  { value: 'SPR', label: 'SPR (Selective Racking)' },
  { value: 'DRIVE_IN', label: 'Drive-in Racking' },
  { value: 'ASRS', label: 'ASRS' },
  { value: 'GROUND_FLOOR', label: 'Ground/Floor (block-stacked)' },
  { value: 'STILLAGE', label: 'Stillage (stacked cages)' },
];
export const RACK_STORAGE_TYPES = ['SPR', 'DRIVE_IN', 'ASRS'];
const ALL_STORAGE_TYPES = STORAGE_TYPE_OPTIONS.map((o) => o.value);

// UI-only narrowing of which Storage Types make practical sense for a given
// Zone Type — e.g. a staging bay is realistically always floor space, never
// racked. NOT enforced by the backend (LocationsService accepts any valid
// zoneType+storageType pair) — this is a data-entry convenience only, so an
// unusual real-world setup this list doesn't anticipate is never blocked via
// direct API use, only hidden as a dropdown option here. Deliberately left
// backend-unenforced (2026-08-24 design pass — see CLAUDE.md) since a UI
// narrowing that turns out wrong is a one-line fix; a hard backend rule that
// turns out wrong blocks a real warehouse's real layout.
const ZONE_STORAGE_COMPAT: Record<string, string[]> = {
  UNLOADING_STAGING: ['GROUND_FLOOR'],
  LOADING_STAGING: ['GROUND_FLOOR'],
  CROSS_DOCK: ['GROUND_FLOOR'],
  PACKING_KITTING: ['GROUND_FLOOR'],
  RETURNS: ['GROUND_FLOOR'],
  RE_PUTAWAY: ['GROUND_FLOOR'],
  QC_HOLD: ['GROUND_FLOOR'],
  DAMAGE_SCRAP: ['GROUND_FLOOR'],
  PICK_FACE: RACK_STORAGE_TYPES,
  ACTUAL_STORAGE: ALL_STORAGE_TYPES,
  FORWARD_PICK: ALL_STORAGE_TYPES,
  SLOB: ALL_STORAGE_TYPES,
  TEMP_CONTROLLED_STORAGE: ALL_STORAGE_TYPES,
  HAZMAT: ALL_STORAGE_TYPES,
};

export function labelFor(options: { value: string; label: string }[], value?: string) {
  return options.find((o) => o.value === value)?.label || value || '—';
}

function authHeaders() {
  const token = localStorage.getItem('token');
  return { Authorization: `Bearer ${token}` };
}

// One line describing the bin's physical position, shape depends on
// storageType — mirrors LocationsService's buildCode logic on the backend.
function positionSummary(l: Location): string {
  if (RACK_STORAGE_TYPES.includes(l.storageType)) {
    const parts = [l.aisle, l.rack && `Rack ${l.rack}`, l.level && `Level ${l.level}`, l.bin && `Bin ${l.bin}`, l.depth ? `Depth ${l.depth}` : null];
    return parts.filter(Boolean).join(', ');
  }
  if (l.storageType === 'GROUND_FLOOR') {
    return [l.aisle, l.block && `Block ${l.block}`, `${l.depth ?? 1}×${l.width ?? 1}×${l.height ?? 1}`].filter(Boolean).join(', ');
  }
  if (l.storageType === 'STILLAGE') {
    return [l.aisle, l.stack && `Stack ${l.stack}`, `${l.depth ?? 1}×${l.width ?? 1}×${l.height ?? 1}`].filter(Boolean).join(', ');
  }
  return l.aisle || '—';
}

function BatchResultList({ summary, totalLabel }: { summary: BatchSummary; totalLabel: string }) {
  const total = summary.totalRequested ?? summary.totalRows ?? summary.results.length;
  return (
    <div style={{ marginTop: 16 }}>
      <p>
        <strong>{summary.successCount}</strong> succeeded, <strong>{summary.failCount}</strong> failed, out of {total} {totalLabel}.
      </p>
      <ul style={{ maxHeight: 220, overflowY: 'auto' }}>
        {summary.results.map((r, i) => (
          <li key={i} style={{ color: r.status === 'error' ? 'crimson' : 'green' }}>
            {r.code || '(row)'}: {r.status === 'success' ? 'Created' : r.errors?.join('; ')}
          </li>
        ))}
      </ul>
    </div>
  );
}

function LocationsPage() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [deleteAllResult, setDeleteAllResult] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [formError, setFormError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  const [warehouseId, setWarehouseId] = useState('');
  const [zoneType, setZoneType] = useState('');
  const [storageType, setStorageType] = useState('');
  const [category, setCategory] = useState('');
  const [zone, setZone] = useState('');
  const [section, setSection] = useState('');
  const [aisle, setAisle] = useState('');
  const [rack, setRack] = useState('');
  const [level, setLevel] = useState('');
  const [bin, setBin] = useState('');
  const [block, setBlock] = useState('');
  const [stack, setStack] = useState('');
  const [depth, setDepth] = useState('');
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');

  // --- Range generator state ---
  const [showGenerator, setShowGenerator] = useState(false);
  const [genError, setGenError] = useState('');
  const [genResult, setGenResult] = useState<BatchSummary | null>(null);
  const [genGenerating, setGenGenerating] = useState(false);
  const [genWarehouseId, setGenWarehouseId] = useState('');
  const [genZoneType, setGenZoneType] = useState('');
  const [genStorageType, setGenStorageType] = useState('');
  const [genCategory, setGenCategory] = useState('');
  const [genZone, setGenZone] = useState('');
  const [genSection, setGenSection] = useState('');
  const [genAisle, setGenAisle] = useState('');
  const [genRackRange, setGenRackRange] = useState('');
  const [genRackRange2, setGenRackRange2] = useState('');
  const [genMirrorRack, setGenMirrorRack] = useState(false);
  const [genLevelRange, setGenLevelRange] = useState('');
  const [genBinRange, setGenBinRange] = useState('');
  // Bin Range only applies to small-parts shelving (multiple bins per
  // level) — pallet racking (the common case) never touches it, so it
  // stays hidden by default rather than cluttering the form with a field
  // that just sits at its default '1' unused. Confirmed 2026-08-25.
  const [genShowBinRange, setGenShowBinRange] = useState(false);
  const [genDepthRange, setGenDepthRange] = useState('');
  const [genBlockRange, setGenBlockRange] = useState('');
  const [genBlockRange2, setGenBlockRange2] = useState('');
  const [genMirrorBlock, setGenMirrorBlock] = useState(false);
  const [genStackRange, setGenStackRange] = useState('');
  const [genDepth, setGenDepth] = useState('');
  const [genWidth, setGenWidth] = useState('');
  const [genHeight, setGenHeight] = useState('');

  // --- Excel import state ---
  const [showImport, setShowImport] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<BatchSummary | null>(null);

  // --- Filter/search state ---
  const [filterWarehouseId, setFilterWarehouseId] = useState('');
  const [filterZoneType, setFilterZoneType] = useState('');
  const [filterStorageType, setFilterStorageType] = useState('');
  const [searchText, setSearchText] = useState('');
  const [showList, setShowList] = useState(true);

  // --- View mode: Table vs. Plan (top-down structural floor plan) ---
  const [viewMode, setViewMode] = useState<'table' | 'plan'>('table');
  const [planWarehouseId, setPlanWarehouseId] = useState('');

  const loadLocations = () => {
    fetch('http://localhost:3000/locations', { headers: authHeaders() })
      .then((res) => {
        if (res.status === 401) {
          localStorage.clear();
          window.location.reload();
          return [];
        }
        return res.json();
      })
      .then((data) => setLocations(Array.isArray(data) ? data : []));
  };

  const loadWarehouses = () => {
    fetch('http://localhost:3000/warehouses', { headers: authHeaders() })
      .then((res) => (res.status === 401 ? [] : res.json()))
      .then((data) => setWarehouses(Array.isArray(data) ? data : []));
  };

  const loadCategories = () => {
    fetch('http://localhost:3000/product-categories', { headers: authHeaders() })
      .then((res) => (res.status === 401 ? [] : res.json()))
      .then((data) => setCategories(Array.isArray(data) ? data : []));
  };

  useEffect(() => {
    loadLocations();
    loadWarehouses();
    loadCategories();
  }, []);

  const resetForm = () => {
    setEditingId(null);
    setWarehouseId('');
    setZoneType('');
    setStorageType('');
    setCategory('');
    setZone('');
    setSection('');
    setAisle('');
    setRack('');
    setLevel('');
    setBin('');
    setBlock('');
    setStack('');
    setDepth('');
    setWidth('');
    setHeight('');
    // The form only ever opens via startEdit() now (no blank "Add" entry
    // point) — so resetting it should also close it, not leave an empty
    // form stuck open with nothing to fill it back in.
    setShowForm(false);
  };

  const startEdit = (l: Location) => {
    setEditingId(l.id);
    setWarehouseId(l.warehouseId);
    setZoneType(l.zoneType);
    setStorageType(l.storageType);
    setCategory(l.category?.name || '');
    setZone(l.zone || '');
    setSection(l.section || '');
    setAisle(l.aisle || '');
    setRack(l.rack || '');
    setLevel(l.level || '');
    setBin(l.bin || '');
    setBlock(l.block || '');
    setStack(l.stack || '');
    // Prisma serializes an unset optional int as JSON `null`, not an absent
    // key — a `!== undefined` check alone lets `null` through, which then
    // stringifies to the literal text "null" and fails backend validation.
    setDepth(l.depth != null ? String(l.depth) : '');
    setWidth(l.width != null ? String(l.width) : '');
    setHeight(l.height != null ? String(l.height) : '');
    setFormError('');
    setShowForm(true);
  };

  // Edit-only now — there is no manual "create a brand-new Location" path
  // (removed 2026-08-25: the range generator already covers single-location
  // creation, and having two ways to create the same thing was confusing
  // rather than useful). This form only ever opens via startEdit(), so
  // editingId is always set by the time this fires.
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    if (!editingId) return;
    const payload = {
      warehouseId,
      zoneType,
      storageType,
      category: category || undefined,
      zone: zone || undefined,
      section: section || undefined,
      aisle,
      rack: rack || undefined,
      level: level || undefined,
      bin: bin || undefined,
      block: block || undefined,
      stack: stack || undefined,
      depth: depth || undefined,
      width: width || undefined,
      height: height || undefined,
    };
    const res = await fetch(`http://localhost:3000/locations/${editingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      setFormError(Array.isArray(data.message) ? data.message.join(' | ') : data.message);
      return;
    }
    resetForm();
    loadLocations();
  };

  const handleDeactivate = async (id: string, isActive: boolean) => {
    const action = isActive ? 'deactivate' : 'reactivate';
    await fetch(`http://localhost:3000/locations/${id}/${action}`, { method: 'PATCH', headers: authHeaders() });
    loadLocations();
  };

  const handleDelete = async (id: string, code: string) => {
    if (!confirm(`Permanently delete ${code}? This cannot be undone.`)) return;
    const res = await fetch(`http://localhost:3000/locations/${id}`, { method: 'DELETE', headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) {
      alert(data.message || 'Could not delete this location.');
      return;
    }
    loadLocations();
  };

  const handleDeleteAll = async () => {
    if (!confirm('Permanently delete ALL locations that have no linked data (stock movements, putaway tasks, etc.)? This cannot be undone.')) return;
    const res = await fetch('http://localhost:3000/locations/all', { method: 'DELETE', headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) {
      // Without this check, a 403 (Delete All is COMPANY_ADMIN-only) or any
      // other error response has no blockedCodes field — reading .length on
      // it threw silently, so the button appeared to do nothing at all.
      setDeleteAllResult(`Delete All failed: ${Array.isArray(data.message) ? data.message.join(' | ') : data.message || 'Unknown error.'}`);
      return;
    }
    setDeleteAllResult(
      `Deleted ${data.deletedCount} location(s). ${data.blockedCount} blocked (have linked data)${data.blockedCodes.length ? ': ' + data.blockedCodes.join(', ') : ''}.`,
    );
    loadLocations();
  };

  const resetGenerator = () => {
    setGenWarehouseId('');
    setGenZoneType('');
    setGenStorageType('');
    setGenCategory('');
    setGenZone('');
    setGenSection('');
    setGenAisle('');
    setGenRackRange('');
    setGenRackRange2('');
    setGenMirrorRack(false);
    setGenLevelRange('');
    setGenBinRange('');
    setGenShowBinRange(false);
    setGenDepthRange('');
    setGenBlockRange('');
    setGenBlockRange2('');
    setGenMirrorBlock(false);
    setGenStackRange('');
    setGenDepth('');
    setGenWidth('');
    setGenHeight('');
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    setGenError('');
    setGenResult(null);
    setGenGenerating(true);
    const payload = {
      warehouseId: genWarehouseId,
      zoneType: genZoneType,
      storageType: genStorageType,
      category: genCategory || undefined,
      zone: genZone || undefined,
      section: genSection || undefined,
      aisle: genAisle,
      rackRange: genRackRange || undefined,
      // "Mirror" checkbox: reuse the primary Rack Range's own numbers for the
      // second flank instead of whatever's typed in the Second Rack Range box
      // — the backend tags these rows side:'B' and appends a letter to their
      // code so they stay unique despite reusing the same rack numbers.
      rackRange2: genMirrorRack ? genRackRange || undefined : genRackRange2 || undefined,
      levelRange: genLevelRange || undefined,
      binRange: genShowBinRange ? genBinRange || undefined : undefined,
      depthRange: genDepthRange || undefined,
      blockRange: genBlockRange || undefined,
      blockRange2: genMirrorBlock ? genBlockRange || undefined : genBlockRange2 || undefined,
      stackRange: genStackRange || undefined,
      depth: genDepth || undefined,
      width: genWidth || undefined,
      height: genHeight || undefined,
    };
    const res = await fetch('http://localhost:3000/locations/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    setGenGenerating(false);
    if (!res.ok) {
      setGenError(Array.isArray(data.message) ? data.message.join(' | ') : data.message);
      return;
    }
    setGenResult(data);
    resetGenerator();
    loadLocations();
  };

  const handleImport = async () => {
    if (!importFile) return;
    setImporting(true);
    setImportResult(null);
    const formData = new FormData();
    formData.append('file', importFile);
    const res = await fetch('http://localhost:3000/locations/import', { method: 'POST', headers: authHeaders(), body: formData });
    const data = await res.json();
    setImportResult(data);
    setImporting(false);
    setImportFile(null);
    loadLocations();
  };

  const handleExport = () => {
    fetch('http://localhost:3000/locations/export', { headers: authHeaders() })
      .then((res) => res.blob())
      .then((blob) => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'Location_Master_Export.xlsx';
        a.click();
        window.URL.revokeObjectURL(url);
      });
  };

  // Location Labels (2026-08-29) — a ZIP of one Code128 barcode PNG per
  // location, encoding its Rack Name. Used both right after the range
  // generator (labels for the just-created batch, see genResult below) and
  // as a standalone "Download Labels" action on the currently-filtered
  // Table View list.
  const [labelsError, setLabelsError] = useState('');
  const handleDownloadLabels = async (locationIds: string[]) => {
    setLabelsError('');
    const res = await fetch('http://localhost:3000/locations/labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ locationIds }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setLabelsError(Array.isArray(data?.message) ? data.message.join(' | ') : data?.message || 'Could not generate labels.');
      return;
    }
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Location_Labels.zip';
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const isRack = RACK_STORAGE_TYPES.includes(storageType);
  const isGround = storageType === 'GROUND_FLOOR';
  const isStillage = storageType === 'STILLAGE';

  const genIsRack = RACK_STORAGE_TYPES.includes(genStorageType);
  const genIsGround = genStorageType === 'GROUND_FLOOR';
  const genIsStillage = genStorageType === 'STILLAGE';

  const searchLower = searchText.trim().toLowerCase();
  const filteredLocations = locations.filter((l) => {
    if (filterWarehouseId && l.warehouseId !== filterWarehouseId) return false;
    if (filterZoneType && l.zoneType !== filterZoneType) return false;
    if (filterStorageType && l.storageType !== filterStorageType) return false;
    if (searchLower) {
      const haystack = [l.code, l.aisle, l.rack, l.level, l.bin, l.block, l.stack, l.zone, l.section].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(searchLower)) return false;
    }
    return true;
  });

  const locationStats = {
    total: locations.length,
    active: locations.filter((l) => l.isActive).length,
    inactive: locations.filter((l) => !l.isActive).length,
  };

  return (
    <div style={{ maxWidth: 1200, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1>Locations / Bins</h1>

      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" onClick={() => setShowImport(!showImport)}>
          {showImport ? '▾ Hide Excel import' : '▸ Import from Excel'}
        </button>
        <button onClick={handleDeleteAll} style={{ color: 'crimson' }}>Delete All</button>
        <button type="button" onClick={() => setShowGenerator(!showGenerator)}>
          {showGenerator ? '▾ Hide range generator' : '▸ Generate a range of Locations'}
        </button>
        <button onClick={handleExport}>Export to Excel</button>
      </div>

      {deleteAllResult && <p style={{ marginTop: -8, marginBottom: 16, textAlign: 'center' }}>{deleteAllResult}</p>}

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 24 }}>
        <div style={cardStyle}><strong>{locationStats.total}</strong><div>Total Locations</div></div>
        <div style={cardStyle}><strong>{locationStats.active}</strong><div>Active</div></div>
        <div style={cardStyle}><strong>{locationStats.inactive}</strong><div>Inactive</div></div>
      </div>

      {showImport && (
        <div style={{ marginBottom: 24 }}>
          <p style={{ fontSize: 12, color: '#666', marginBottom: 8, textAlign: 'center' }}>
            One row per Location, on a sheet named exactly <code>Location Import</code>. Columns: <code>Warehouse Code*</code>,{' '}
            <code>Zone Type*</code>, <code>Storage Type*</code>, <code>Category</code>, <code>Zone</code>, <code>Section</code>,{' '}
            <code>Aisle*</code>, <code>Rack</code>, <code>Level</code>, <code>Bin</code>, <code>Block</code>, <code>Stack</code>,{' '}
            <code>Depth</code>, <code>Width</code>, <code>Height</code> — only fill the columns relevant to a row's Storage
            Type (Rack/Level for rack storage; Block+Depth+Width for Ground/Floor; Stack+Height for Stillage), the rest can
            be left blank. <code>Section</code> is one-per-Aisle — leave it blank for a row whose Aisle already has one set.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 8 }}>
            <a href="/templates/Location_Master_Import_Template.xlsx" download>Download Template</a>
            <input type="file" accept=".xlsx" onChange={(e) => setImportFile(e.target.files ? e.target.files[0] : null)} />
            <button onClick={handleImport} disabled={!importFile || importing}>
              {importing ? 'Importing...' : 'Import'}
            </button>
          </div>
          {importResult && <BatchResultList summary={importResult} totalLabel="rows" />}
        </div>
      )}

      {showGenerator && (
        <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>Generate a range of Locations</h3>
          <p style={{ marginTop: -4, marginBottom: 12, fontSize: 12, color: '#888' }}>
            * required. A range field accepts <code>01-20</code> (zero-padding preserved) or a single fixed value repeated for
            every generated location. Depth/Width/Height for Ground/Floor and Stillage stay fixed across the whole batch — only
            the Block/Stack identifier varies. <strong>Section</strong> is one-per-Aisle always — leave it blank on a later
            batch for an Aisle that already has one and it's reused automatically; typing a different Section for that same
            Aisle is blocked.
          </p>
          <form onSubmit={handleGenerate}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <select value={genWarehouseId} onChange={(e) => setGenWarehouseId(e.target.value)} required style={{ width: 180 }}>
                <option value="">Warehouse *</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
              </select>
              <select
                value={genZoneType}
                onChange={(e) => {
                  const next = e.target.value;
                  setGenZoneType(next);
                  const allowed = ZONE_STORAGE_COMPAT[next] || ALL_STORAGE_TYPES;
                  if (genStorageType && !allowed.includes(genStorageType)) setGenStorageType('');
                }}
                required
                style={{ width: 190 }}
              >
                <option value="">Zone Type *</option>
                {ZONE_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <select value={genStorageType} onChange={(e) => setGenStorageType(e.target.value)} required style={{ width: 200 }}>
                <option value="">Storage Type *</option>
                {STORAGE_TYPE_OPTIONS.filter((o) => (ZONE_STORAGE_COMPAT[genZoneType] || ALL_STORAGE_TYPES).includes(o.value)).map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <select value={genCategory} onChange={(e) => setGenCategory(e.target.value)} style={{ width: 160 }}>
                <option value="">Category (none)</option>
                {categories.filter((c) => c.name !== 'Uncategorized').map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
              <input placeholder="Zone label (e.g. Zone 1)" value={genZone} onChange={(e) => setGenZone(e.target.value)} style={{ width: 150 }} />
              <input
                placeholder="Section (e.g. A) — one per Aisle"
                value={genSection}
                onChange={(e) => setGenSection(e.target.value)}
                style={{ width: 170 }}
              />
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
              <input placeholder="Aisle *" value={genAisle} onChange={(e) => setGenAisle(e.target.value)} required style={{ width: 100 }} />

              {genIsRack && (
                <>
                  <input placeholder="Rack Range * (e.g. 01-20)" value={genRackRange} onChange={(e) => setGenRackRange(e.target.value)} required style={{ width: 170 }} />
                  <input
                    placeholder="+ Second Rack Range (other side of aisle)"
                    value={genRackRange2}
                    onChange={(e) => setGenRackRange2(e.target.value)}
                    disabled={genMirrorRack}
                    style={{ width: 250 }}
                  />
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
                    <input type="checkbox" checked={genMirrorRack} onChange={(e) => setGenMirrorRack(e.target.checked)} />
                    Mirror same numbers on other side
                  </label>
                  <input placeholder="Level Range * (e.g. 01-04)" value={genLevelRange} onChange={(e) => setGenLevelRange(e.target.value)} required style={{ width: 170 }} />
                  <input placeholder="Depth = lane depth (e.g. 2 → positions 1-2)" value={genDepthRange} onChange={(e) => setGenDepthRange(e.target.value)} style={{ width: 260 }} />
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, width: '100%' }}>
                    <input type="checkbox" checked={genShowBinRange} onChange={(e) => setGenShowBinRange(e.target.checked)} />
                    This rack has multiple bins per level (small-parts shelving)
                  </label>
                  {genShowBinRange && (
                    <input placeholder="Bin Range (default 1)" value={genBinRange} onChange={(e) => setGenBinRange(e.target.value)} style={{ width: 170 }} />
                  )}
                </>
              )}

              {genIsGround && (
                <>
                  <input placeholder="Block Range * (e.g. 01-10)" value={genBlockRange} onChange={(e) => setGenBlockRange(e.target.value)} required style={{ width: 170 }} />
                  <input
                    placeholder="+ Second Block Range (other side of aisle)"
                    value={genBlockRange2}
                    onChange={(e) => setGenBlockRange2(e.target.value)}
                    disabled={genMirrorBlock}
                    style={{ width: 260 }}
                  />
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
                    <input type="checkbox" checked={genMirrorBlock} onChange={(e) => setGenMirrorBlock(e.target.checked)} />
                    Mirror same numbers on other side
                  </label>
                  <input placeholder="Depth (pallets deep) *" value={genDepth} onChange={(e) => setGenDepth(e.target.value)} required style={{ width: 170 }} />
                  <input placeholder="Width (stacks wide) *" value={genWidth} onChange={(e) => setGenWidth(e.target.value)} required style={{ width: 170 }} />
                  <input placeholder="Height (layers, default 1)" value={genHeight} onChange={(e) => setGenHeight(e.target.value)} style={{ width: 190 }} />
                </>
              )}

              {genIsStillage && (
                <>
                  <input placeholder="Stack Range * (e.g. 01-05)" value={genStackRange} onChange={(e) => setGenStackRange(e.target.value)} required style={{ width: 170 }} />
                  <input placeholder="Height (stillages stacked) *" value={genHeight} onChange={(e) => setGenHeight(e.target.value)} required style={{ width: 210 }} />
                  <input placeholder="Depth (columns deep, default 1)" value={genDepth} onChange={(e) => setGenDepth(e.target.value)} style={{ width: 210 }} />
                  <input placeholder="Width (columns wide, default 1)" value={genWidth} onChange={(e) => setGenWidth(e.target.value)} style={{ width: 210 }} />
                </>
              )}
            </div>

            {genIsRack && (
              <p style={{ marginTop: 8, marginBottom: 12, fontSize: 12, color: '#666' }}>
                e.g. Aisle <strong>A01</strong>, Rack Range <strong>01-20</strong>, Level Range <strong>01-04</strong> → creates 80
                locations (<code>A01-R01-L01-B1</code> … <code>A01-R20-L04-B1</code>) in one go. Fill{' '}
                <strong>Second Rack Range</strong> too (e.g. <strong>21-40</strong>) to generate the racking on the *other* side of
                this same aisle in the same call — same Aisle, same Depth, just a non-overlapping set of rack numbers. Depth means
                the lane's full depth: entering <strong>2</strong> creates *both* the front and back pallet position for a 2-deep
                Drive-in lane (not just the back one) — use an explicit range like <strong>3-5</strong> only to add specific
                positions to a lane that's already partly built.
              </p>
            )}
            {genIsGround && (
              <p style={{ marginTop: 8, marginBottom: 12, fontSize: 12, color: '#666' }}>
                e.g. Aisle <strong>GA1</strong>, Block Range <strong>01-10</strong>, Depth <strong>4</strong>, Width <strong>4</strong> →
                creates 10 blocks (<code>GF-GA1-BLK01</code> … <code>GF-GA1-BLK10</code>), each capacity 16. Fill{' '}
                <strong>Second Block Range</strong> too (e.g. <strong>11-20</strong>) to generate the blocks on the other side of
                this same aisle in the same call, same Depth/Width/Height for both sides.
              </p>
            )}
            {genIsStillage && (
              <p style={{ marginTop: 8, marginBottom: 12, fontSize: 12, color: '#666' }}>
                e.g. Aisle <strong>SA1</strong>, Stack Range <strong>01-05</strong>, Height <strong>3</strong> → creates 5 stacks
                (<code>ST-SA1-01</code> … <code>ST-SA1-05</code>), each capacity 3.
              </p>
            )}

            {genError && <p style={{ color: 'crimson' }}>{genError}</p>}
            <div>
              <button type="submit" disabled={genGenerating}>{genGenerating ? 'Generating...' : 'Generate'}</button>
            </div>
          </form>
          {genResult && <BatchResultList summary={genResult} totalLabel="locations requested" />}
          {genResult && genResult.successCount > 0 && (
            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                onClick={() => handleDownloadLabels(genResult.results.filter((r) => r.status === 'success' && r.id).map((r) => r.id!))}
              >
                Download Labels for {genResult.successCount} generated location(s)
              </button>
              {labelsError && <p style={{ color: 'crimson' }}>{labelsError}</p>}
            </div>
          )}
        </div>
      )}

      {showForm && (
        <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>Edit Location</h3>
          <p style={{ marginTop: -4, marginBottom: 12, fontSize: 12, color: '#888' }}>* required</p>
          <form onSubmit={handleSubmit}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} required style={{ width: 180 }}>
                <option value="">Warehouse *</option>
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
              </select>
              <select
                value={zoneType}
                onChange={(e) => {
                  const nextZoneType = e.target.value;
                  setZoneType(nextZoneType);
                  // Narrow Storage Type's options to what's realistic for this
                  // Zone Type — clear a now-incompatible selection rather than
                  // leave a stale choice the dropdown no longer offers.
                  const allowed = ZONE_STORAGE_COMPAT[nextZoneType] || ALL_STORAGE_TYPES;
                  if (storageType && !allowed.includes(storageType)) setStorageType('');
                }}
                required
                style={{ width: 190 }}
              >
                <option value="">Zone Type *</option>
                {ZONE_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <select value={storageType} onChange={(e) => setStorageType(e.target.value)} required style={{ width: 200 }}>
                <option value="">Storage Type *</option>
                {STORAGE_TYPE_OPTIONS.filter((o) => (ZONE_STORAGE_COMPAT[zoneType] || ALL_STORAGE_TYPES).includes(o.value)).map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 160 }}>
                <option value="">Category (none)</option>
                {categories.filter((c) => c.name !== 'Uncategorized').map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
              <input placeholder="Zone label (e.g. Zone 1)" value={zone} onChange={(e) => setZone(e.target.value)} style={{ width: 150 }} />
              <input
                placeholder="Section (e.g. A) — one per Aisle"
                value={section}
                onChange={(e) => setSection(e.target.value)}
                style={{ width: 170 }}
              />
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
              <input placeholder="Aisle *" value={aisle} onChange={(e) => setAisle(e.target.value)} required style={{ width: 100 }} />

              {isRack && (
                <>
                  <input placeholder="Rack *" value={rack} onChange={(e) => setRack(e.target.value)} required style={{ width: 100 }} />
                  <input placeholder="Level *" value={level} onChange={(e) => setLevel(e.target.value)} required style={{ width: 100 }} />
                  <input placeholder="Bin (default 1)" value={bin} onChange={(e) => setBin(e.target.value)} style={{ width: 130 }} />
                  <input placeholder="Depth (multi-deep lane position)" value={depth} onChange={(e) => setDepth(e.target.value)} style={{ width: 220 }} />
                </>
              )}

              {isGround && (
                <>
                  <input placeholder="Block *" value={block} onChange={(e) => setBlock(e.target.value)} required style={{ width: 100 }} />
                  <input placeholder="Depth (pallets deep) *" value={depth} onChange={(e) => setDepth(e.target.value)} required style={{ width: 170 }} />
                  <input placeholder="Width (stacks wide) *" value={width} onChange={(e) => setWidth(e.target.value)} required style={{ width: 170 }} />
                  <input placeholder="Height (layers, default 1)" value={height} onChange={(e) => setHeight(e.target.value)} style={{ width: 190 }} />
                </>
              )}

              {isStillage && (
                <>
                  <input placeholder="Stack *" value={stack} onChange={(e) => setStack(e.target.value)} required style={{ width: 100 }} />
                  <input placeholder="Height (stillages stacked) *" value={height} onChange={(e) => setHeight(e.target.value)} required style={{ width: 210 }} />
                  <input placeholder="Depth (columns deep, default 1)" value={depth} onChange={(e) => setDepth(e.target.value)} style={{ width: 210 }} />
                  <input placeholder="Width (columns wide, default 1)" value={width} onChange={(e) => setWidth(e.target.value)} style={{ width: 210 }} />
                </>
              )}
            </div>

            {isRack && (
              <p style={{ marginTop: 0, marginBottom: 12, fontSize: 12, color: '#666' }}>
                e.g. Aisle <strong>A01</strong>, Rack <strong>05</strong>, Level <strong>02</strong>, Bin <strong>01</strong> → code{' '}
                <code>A01-R05-L02-B01</code>. Only fill Depth for multi-deep Drive-in lanes (e.g. Depth <strong>2</strong> = 2nd pallet
                back in that lane) — leave it blank for single-deep SPR/ASRS.
              </p>
            )}
            {isGround && (
              <p style={{ marginTop: 0, marginBottom: 12, fontSize: 12, color: '#666' }}>
                e.g. Aisle <strong>A01</strong>, Block <strong>07</strong>, Depth <strong>4</strong>, Width <strong>4</strong> (a
                4-pallets-deep × 4-stacks-wide floor block, 16 positions) → code <code>GF-A01-BLK07</code>, Capacity <strong>16</strong>.
              </p>
            )}
            {isStillage && (
              <p style={{ marginTop: 0, marginBottom: 12, fontSize: 12, color: '#666' }}>
                e.g. Aisle <strong>S01</strong>, Stack <strong>04</strong>, Height <strong>3</strong> (3 stillages stacked one on
                another) → code <code>ST-S01-04</code>, Capacity <strong>3</strong>. Depth/Width only matter if several stillage
                columns sit side by side as one location.
              </p>
            )}

            {formError && <p style={{ color: 'crimson' }}>{formError}</p>}
            <div>
              <button type="submit">Save Changes</button>
              <button type="button" onClick={resetForm} style={{ marginLeft: 8 }}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <h2 style={{ marginBottom: 8, cursor: 'pointer', userSelect: 'none' }} onClick={() => setShowList(!showList)}>
        {showList ? '▾' : '▸'} List of Locations
      </h2>

      {showList && (
      <>
      <div style={{ marginBottom: 12 }}>
        <button
          type="button"
          onClick={() => setViewMode('table')}
          style={{ fontWeight: viewMode === 'table' ? 'bold' : 'normal' }}
        >
          Table View
        </button>
        <button
          type="button"
          onClick={() => {
            setViewMode('plan');
            if (!planWarehouseId && filterWarehouseId) setPlanWarehouseId(filterWarehouseId);
          }}
          style={{ marginLeft: 8, fontWeight: viewMode === 'plan' ? 'bold' : 'normal' }}
        >
          Plan View
        </button>
      </div>

      {viewMode === 'table' && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12, alignItems: 'center' }}>
            <select value={filterWarehouseId} onChange={(e) => setFilterWarehouseId(e.target.value)} style={{ width: 180 }}>
              <option value="">All Warehouses</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
            </select>
            <select value={filterZoneType} onChange={(e) => setFilterZoneType(e.target.value)} style={{ width: 190 }}>
              <option value="">All Zone Types</option>
              {ZONE_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select value={filterStorageType} onChange={(e) => setFilterStorageType(e.target.value)} style={{ width: 200 }}>
              <option value="">All Storage Types</option>
              {STORAGE_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <input
              placeholder="Search code / aisle / section / rack / block / stack..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              style={{ width: 260 }}
            />
            <span style={{ fontSize: 13, color: '#666' }}>
              Showing {filteredLocations.length} of {locations.length}
            </span>
            <button
              type="button" disabled={filteredLocations.length === 0}
              onClick={() => handleDownloadLabels(filteredLocations.map((l) => l.id))}
            >
              Download Labels for {filteredLocations.length} shown
            </button>
          </div>
          {labelsError && <p style={{ textAlign: 'center', color: 'crimson' }}>{labelsError}</p>}

          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 32 }}>
            <thead>
              <tr style={{ textAlign: 'center', borderBottom: '2px solid #ccc' }}>
                <th style={{ padding: 8 }}>Code</th>
                <th style={{ padding: 8 }}>Warehouse</th>
                <th style={{ padding: 8 }}>Zone Type</th>
                <th style={{ padding: 8 }}>Storage Type</th>
                <th style={{ padding: 8 }}>Category</th>
                <th style={{ padding: 8 }}>Section</th>
                <th style={{ padding: 8 }}>Position</th>
                <th style={{ padding: 8 }}>Capacity</th>
                <th style={{ padding: 8 }}>Status</th>
                <th style={{ padding: 8 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredLocations.map((l) => (
                <tr key={l.id} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: 8, fontWeight: 'bold' }}>{l.code}</td>
                  <td style={{ padding: 8 }}>{l.warehouse.code}</td>
                  <td style={{ padding: 8 }}>{labelFor(ZONE_TYPE_OPTIONS, l.zoneType)}</td>
                  <td style={{ padding: 8 }}>{labelFor(STORAGE_TYPE_OPTIONS, l.storageType)}</td>
                  <td style={{ padding: 8 }}>{l.category?.name || '—'}</td>
                  <td style={{ padding: 8 }}>{l.section || '—'}</td>
                  <td style={{ padding: 8 }}>{positionSummary(l)}</td>
                  <td style={{ padding: 8 }}>{l.capacity ?? '—'}</td>
                  <td style={{ padding: 8 }}>{l.isActive ? 'Active' : 'Inactive'}</td>
                  <td style={{ padding: 8, whiteSpace: 'nowrap' }}>
                    <button onClick={() => startEdit(l)}>Edit</button>
                    <button onClick={() => handleDeactivate(l.id, l.isActive)} style={{ marginLeft: 6 }}>
                      {l.isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                    <button onClick={() => handleDelete(l.id, l.code)} style={{ marginLeft: 6, color: 'crimson' }}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {filteredLocations.length === 0 && <p style={{ marginTop: 16 }}>No locations found{locations.length > 0 ? ' matching this filter' : ''}.</p>}
        </>
      )}

      {viewMode === 'plan' && (
        <div style={{ marginBottom: 32 }}>
          <div style={{ marginBottom: 8 }}>
            <select value={planWarehouseId} onChange={(e) => setPlanWarehouseId(e.target.value)} style={{ width: 220 }}>
              <option value="">Select a Warehouse to view its plan...</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
            </select>
          </div>
          {planWarehouseId ? (
            <LocationsPlanView
              locations={locations.filter((l) => l.warehouseId === planWarehouseId)}
              warehouseLabel={labelFor(warehouses.map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` })), planWarehouseId)}
            />
          ) : (
            <p style={{ marginTop: 16, color: '#666' }}>Pick a warehouse above to render its layout.</p>
          )}
        </div>
      )}
      </>
      )}
    </div>
  );
}

export default LocationsPage;

const cardStyle: React.CSSProperties = {
  border: '1px solid #ccc',
  borderRadius: 8,
  padding: '12px 16px',
  textAlign: 'center',
  minWidth: 100,
};

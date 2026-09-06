import { useEffect, useState } from 'react';

// The first Company Settings page this project has ever had (2026-08-27) —
// started scoped narrow to just detention settings, per
// backend/src/companies/'s own comment, then grew an "ERP Integration"
// section the same day (ERP push). Every other per-company toggle (E-Way
// Bill requirement, yard-full blocking, gate pass reset period,
// security-supervisor-only gate access) still has no UI at all — extend
// this same page for those later rather than building a second settings
// surface.

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

type Settings = {
  id: string;
  name: string;
  detentionCostPerDay?: number | null;
  detentionFreeHours?: number | null;
  detentionAlertHours?: number | null;
  detentionEscalationHours?: number | null;
  allowErpInboundPush?: boolean;
  erpApiKey?: string | null;
  putawayTriggerMode?: 'BATCH' | 'IMMEDIATE';
  putawayDefaultBatchQty?: number | string | null;
  defaultMaxCasesPerPallet?: number | string | null;
  putawayAssignmentGraceMinutes?: number | string;
  allowPutawayLocationOverride?: boolean;
  abcReassessmentEnabled?: boolean;
  abcClassAPercent?: number | string;
  abcClassBPercent?: number | string;
  abcClassCPercent?: number | string;
  abcAssessmentWindowMonths?: number | string;
};

// Aging Methodology (2026-08-29) is warehouse-scoped, not company-scoped —
// "depends on the node the granularity might be different." No Warehouse
// Edit form exists in this app to hang a field like this off, so it's a
// small "pick a warehouse, edit its own setting" control living here on
// Company Settings instead — same pattern EquipmentPage.tsx's own
// "Configure Equipment Type Matrix" section already established.
// Dock Configuration (2026-09-06, Topic 2 — see wms-abc-velocity-design
// memory) is the real, physical counterpart to the ABC velocity numbers
// below: 0-2 WarehouseDockZone rows telling Putaway's bin suggestion which
// end of this warehouse's own aisle order sits near an Inbound/Outbound/
// Both dock — a U-shape warehouse needs just one (client's own worked
// example), an I-shape (opposite-end docks) needs two. Same "no general
// Warehouse Edit form, so it lives here" reasoning as Aging Methodology.
type DockZoneRow = { purpose: 'INBOUND' | 'OUTBOUND' | 'BOTH'; nearAisleEnd: 'LOW' | 'HIGH' };
// Storage-type SKU-sharing caps + column-boundary toggles (2026-09-06 —
// see the Ground design conversation in wms-putaway-design memory).
// maxSkusClass* has real enforcement in suggestBin() for BOTH Rack and
// Ground/Floor, but never had a UI to set it until now; respectsColumn
// Boundaries* only means anything for GROUND_FLOOR (a Rack lane's depth
// positions are already individually addressable, there's no "column" to
// subdivide further) but is harmless to carry on any row regardless.
type StorageTypeRow = {
  id: string;
  storageType: string;
  category?: { id: string; name: string } | null;
  maxSkusClassA?: number | null;
  maxSkusClassB?: number | null;
  maxSkusClassC?: number | null;
  respectsColumnBoundariesClassA?: boolean;
  respectsColumnBoundariesClassB?: boolean;
  respectsColumnBoundariesClassC?: boolean;
  respectsColumnBoundariesClassD?: boolean;
};
// pickFaceEnabled (2026-09-05) rides the same WarehouseRow/picker too —
// same "no general Warehouse Edit form" reason.
type WarehouseRow = {
  id: string;
  code: string;
  name: string;
  agingGranularity?: 'DAY' | 'WEEK' | 'MONTH' | null;
  dockZones?: DockZoneRow[];
  pickFaceEnabled?: boolean;
  storageTypes?: StorageTypeRow[];
};

function CompanySettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [detentionCostPerDay, setDetentionCostPerDay] = useState('');
  const [detentionFreeHours, setDetentionFreeHours] = useState('');
  const [detentionAlertHours, setDetentionAlertHours] = useState('');
  const [detentionEscalationHours, setDetentionEscalationHours] = useState('');
  const [allowErpInboundPush, setAllowErpInboundPush] = useState(false);
  const [putawayTriggerMode, setPutawayTriggerMode] = useState<'BATCH' | 'IMMEDIATE'>('IMMEDIATE');
  const [putawayDefaultBatchQty, setPutawayDefaultBatchQty] = useState('');
  const [defaultMaxCasesPerPallet, setDefaultMaxCasesPerPallet] = useState('');
  const [putawayAssignmentGraceMinutes, setPutawayAssignmentGraceMinutes] = useState('2');
  const [allowPutawayLocationOverride, setAllowPutawayLocationOverride] = useState(false);
  const [abcReassessmentEnabled, setAbcReassessmentEnabled] = useState(false);
  const [abcClassAPercent, setAbcClassAPercent] = useState('75');
  const [abcClassBPercent, setAbcClassBPercent] = useState('15');
  const [abcClassCPercent, setAbcClassCPercent] = useState('10');
  const [abcAssessmentWindowMonths, setAbcAssessmentWindowMonths] = useState('3');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [keyError, setKeyError] = useState('');
  const [regenerating, setRegenerating] = useState(false);

  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([]);
  const [agingWarehouseId, setAgingWarehouseId] = useState('');
  const [agingGranularity, setAgingGranularity] = useState<'DAY' | 'WEEK' | 'MONTH'>('DAY');
  const [agingError, setAgingError] = useState('');
  const [agingSaved, setAgingSaved] = useState(false);
  const [agingSaving, setAgingSaving] = useState(false);

  const [dockZoneWarehouseId, setDockZoneWarehouseId] = useState('');
  const [dockZoneRows, setDockZoneRows] = useState<DockZoneRow[]>([]);
  const [dockZoneError, setDockZoneError] = useState('');
  const [dockZoneSaved, setDockZoneSaved] = useState(false);
  const [dockZoneSaving, setDockZoneSaving] = useState(false);

  // Pick Face (2026-09-05, SPR only — see [[wms-putaway-design]]) — the
  // warehouse-level on/off switch, riding the same warehouse picker as
  // Aging Methodology above.
  const [pickFaceEnabled, setPickFaceEnabled] = useState(false);
  const [pickFaceError, setPickFaceError] = useState('');
  const [pickFaceSaved, setPickFaceSaved] = useState(false);
  const [pickFaceSaving, setPickFaceSaving] = useState(false);

  // Storage-type SKU-sharing caps + column-boundary toggles (2026-09-06) —
  // its own warehouse picker AND a storage-type-row picker, since a
  // warehouse can have several WarehouseStorageType rows (one per storage
  // type x category) each needing its own numbers.
  const [capsWarehouseId, setCapsWarehouseId] = useState('');
  const [capsRowId, setCapsRowId] = useState('');
  const [capsMaxA, setCapsMaxA] = useState('');
  const [capsMaxB, setCapsMaxB] = useState('');
  const [capsMaxC, setCapsMaxC] = useState('');
  const [capsBoundaryA, setCapsBoundaryA] = useState(true);
  const [capsBoundaryB, setCapsBoundaryB] = useState(true);
  const [capsBoundaryC, setCapsBoundaryC] = useState(true);
  const [capsBoundaryD, setCapsBoundaryD] = useState(false);
  const [capsError, setCapsError] = useState('');
  const [capsSaved, setCapsSaved] = useState(false);
  const [capsSaving, setCapsSaving] = useState(false);

  const load = () => {
    fetch('http://localhost:3000/companies/settings', { headers: authHeaders() })
      .then((res) => {
        if (res.status === 401) { localStorage.clear(); window.location.reload(); return null; }
        return res.json();
      })
      .then((data: Settings | null) => {
        if (!data) return;
        setSettings(data);
        setDetentionCostPerDay(data.detentionCostPerDay != null ? String(data.detentionCostPerDay) : '');
        setDetentionFreeHours(data.detentionFreeHours != null ? String(data.detentionFreeHours) : '');
        setDetentionAlertHours(data.detentionAlertHours != null ? String(data.detentionAlertHours) : '');
        setDetentionEscalationHours(data.detentionEscalationHours != null ? String(data.detentionEscalationHours) : '');
        setAllowErpInboundPush(!!data.allowErpInboundPush);
        setPutawayTriggerMode(data.putawayTriggerMode === 'BATCH' ? 'BATCH' : 'IMMEDIATE');
        setPutawayDefaultBatchQty(data.putawayDefaultBatchQty != null ? String(data.putawayDefaultBatchQty) : '');
        setDefaultMaxCasesPerPallet(data.defaultMaxCasesPerPallet != null ? String(data.defaultMaxCasesPerPallet) : '');
        setPutawayAssignmentGraceMinutes(data.putawayAssignmentGraceMinutes != null ? String(data.putawayAssignmentGraceMinutes) : '2');
        setAllowPutawayLocationOverride(!!data.allowPutawayLocationOverride);
        setAbcReassessmentEnabled(!!data.abcReassessmentEnabled);
        setAbcClassAPercent(data.abcClassAPercent != null ? String(data.abcClassAPercent) : '75');
        setAbcClassBPercent(data.abcClassBPercent != null ? String(data.abcClassBPercent) : '15');
        setAbcClassCPercent(data.abcClassCPercent != null ? String(data.abcClassCPercent) : '10');
        setAbcAssessmentWindowMonths(data.abcAssessmentWindowMonths != null ? String(data.abcAssessmentWindowMonths) : '3');
      });
    fetch('http://localhost:3000/warehouses', { headers: authHeaders() })
      .then((res) => (res.status === 401 ? null : res.json()))
      .then((data: WarehouseRow[] | null) => {
        if (!data) return;
        setWarehouses(data);
        if (data.length > 0) {
          setAgingWarehouseId((prev) => prev || data[0].id);
          setAgingGranularity((data[0].agingGranularity as any) || 'DAY');
          setDockZoneWarehouseId((prev) => prev || data[0].id);
          setDockZoneRows(data[0].dockZones || []);
          setPickFaceEnabled(!!data[0].pickFaceEnabled);
          setCapsWarehouseId((prev) => prev || data[0].id);
          const firstRow = (data[0].storageTypes || [])[0];
          if (firstRow) applyCapsRow(firstRow);
        }
      });
  };

  // Shared by the initial load and by switching the warehouse/row pickers —
  // pre-fills the caps editor's fields from one WarehouseStorageType row.
  const applyCapsRow = (row: StorageTypeRow) => {
    setCapsRowId(row.id);
    setCapsMaxA(row.maxSkusClassA != null ? String(row.maxSkusClassA) : '');
    setCapsMaxB(row.maxSkusClassB != null ? String(row.maxSkusClassB) : '');
    setCapsMaxC(row.maxSkusClassC != null ? String(row.maxSkusClassC) : '');
    setCapsBoundaryA(row.respectsColumnBoundariesClassA !== false);
    setCapsBoundaryB(row.respectsColumnBoundariesClassB !== false);
    setCapsBoundaryC(row.respectsColumnBoundariesClassC !== false);
    setCapsBoundaryD(!!row.respectsColumnBoundariesClassD);
  };

  const handleCapsWarehouseChange = (id: string) => {
    setCapsWarehouseId(id);
    setCapsError('');
    setCapsSaved(false);
    const wh = warehouses.find((w) => w.id === id);
    const firstRow = (wh?.storageTypes || [])[0];
    if (firstRow) applyCapsRow(firstRow);
    else setCapsRowId('');
  };

  const handleCapsRowChange = (rowId: string) => {
    setCapsError('');
    setCapsSaved(false);
    const wh = warehouses.find((w) => w.id === capsWarehouseId);
    const row = (wh?.storageTypes || []).find((r) => r.id === rowId);
    if (row) applyCapsRow(row);
  };

  const handleSaveStorageTypeCaps = async () => {
    if (!capsWarehouseId || !capsRowId) return;
    setCapsError('');
    setCapsSaved(false);
    setCapsSaving(true);
    const res = await fetch(`http://localhost:3000/warehouses/${capsWarehouseId}/storage-type-caps`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({
        storageTypeRowId: capsRowId,
        maxSkusClassA: capsMaxA === '' ? null : capsMaxA,
        maxSkusClassB: capsMaxB === '' ? null : capsMaxB,
        maxSkusClassC: capsMaxC === '' ? null : capsMaxC,
        respectsColumnBoundariesClassA: capsBoundaryA,
        respectsColumnBoundariesClassB: capsBoundaryB,
        respectsColumnBoundariesClassC: capsBoundaryC,
        respectsColumnBoundariesClassD: capsBoundaryD,
      }),
    });
    const data = await res.json();
    setCapsSaving(false);
    if (!res.ok) {
      setCapsError(errorText(data, 'Could not save storage-type caps.'));
      return;
    }
    setWarehouses((prev) =>
      prev.map((w) =>
        w.id !== capsWarehouseId
          ? w
          : { ...w, storageTypes: (w.storageTypes || []).map((r) => (r.id === capsRowId ? data : r)) },
      ),
    );
    setCapsSaved(true);
  };

  useEffect(() => {
    load();
  }, []);

  // Re-fill the Aging Methodology dropdown from the already-fetched
  // warehouse list whenever the picker's selection changes — no extra
  // request, matching the "client-side over the already-fetched list"
  // pattern used elsewhere in this codebase (LocationsPage's own search/
  // filter row).
  const handleAgingWarehouseChange = (id: string) => {
    setAgingWarehouseId(id);
    setAgingError('');
    setAgingSaved(false);
    setPickFaceError('');
    setPickFaceSaved(false);
    const wh = warehouses.find((w) => w.id === id);
    setAgingGranularity((wh?.agingGranularity as any) || 'DAY');
    setPickFaceEnabled(!!wh?.pickFaceEnabled);
  };

  const handleSaveAgingGranularity = async () => {
    if (!agingWarehouseId) return;
    setAgingError('');
    setAgingSaved(false);
    setAgingSaving(true);
    const res = await fetch(`http://localhost:3000/warehouses/${agingWarehouseId}/aging-granularity`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ agingGranularity }),
    });
    const data = await res.json();
    setAgingSaving(false);
    if (!res.ok) {
      setAgingError(errorText(data, 'Could not save Aging Methodology.'));
      return;
    }
    setWarehouses((prev) => prev.map((w) => (w.id === agingWarehouseId ? { ...w, agingGranularity: data.agingGranularity } : w)));
    setAgingSaved(true);
  };

  const handleDockZoneWarehouseChange = (id: string) => {
    setDockZoneWarehouseId(id);
    setDockZoneError('');
    setDockZoneSaved(false);
    const wh = warehouses.find((w) => w.id === id);
    setDockZoneRows(wh?.dockZones || []);
  };

  const addDockZoneRow = () => {
    if (dockZoneRows.length >= 2) return;
    setDockZoneSaved(false);
    setDockZoneRows((prev) => [...prev, { purpose: 'OUTBOUND', nearAisleEnd: 'LOW' }]);
  };

  const removeDockZoneRow = (index: number) => {
    setDockZoneSaved(false);
    setDockZoneRows((prev) => prev.filter((_, i) => i !== index));
  };

  const updateDockZoneRow = (index: number, field: keyof DockZoneRow, value: string) => {
    setDockZoneSaved(false);
    setDockZoneRows((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  };

  const handleSaveDockZones = async () => {
    if (!dockZoneWarehouseId) return;
    setDockZoneError('');
    setDockZoneSaved(false);
    setDockZoneSaving(true);
    const res = await fetch(`http://localhost:3000/warehouses/${dockZoneWarehouseId}/dock-zones`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ zones: dockZoneRows }),
    });
    const data = await res.json();
    setDockZoneSaving(false);
    if (!res.ok) {
      setDockZoneError(errorText(data, 'Could not save Dock Configuration.'));
      return;
    }
    setWarehouses((prev) => prev.map((w) => (w.id === dockZoneWarehouseId ? { ...w, dockZones: data } : w)));
    setDockZoneRows(data);
    setDockZoneSaved(true);
  };

  const handleSavePickFaceEnabled = async () => {
    if (!agingWarehouseId) return;
    setPickFaceError('');
    setPickFaceSaved(false);
    setPickFaceSaving(true);
    const res = await fetch(`http://localhost:3000/warehouses/${agingWarehouseId}/pick-face-enabled`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ pickFaceEnabled }),
    });
    const data = await res.json();
    setPickFaceSaving(false);
    if (!res.ok) {
      setPickFaceError(errorText(data, 'Could not save Pick Face setting.'));
      return;
    }
    setWarehouses((prev) => prev.map((w) => (w.id === agingWarehouseId ? { ...w, pickFaceEnabled: data.pickFaceEnabled } : w)));
    setPickFaceSaved(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaved(false);
    const res = await fetch('http://localhost:3000/companies/settings', {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({
        // An empty field means "clear this back to unconfigured" — sent as
        // null, not just omitted, so Save can actually turn a setting off.
        detentionCostPerDay: detentionCostPerDay === '' ? null : detentionCostPerDay,
        detentionFreeHours: detentionFreeHours === '' ? null : detentionFreeHours,
        detentionAlertHours: detentionAlertHours === '' ? null : detentionAlertHours,
        detentionEscalationHours: detentionEscalationHours === '' ? null : detentionEscalationHours,
        allowErpInboundPush,
        putawayTriggerMode,
        putawayDefaultBatchQty: putawayDefaultBatchQty === '' ? null : putawayDefaultBatchQty,
        defaultMaxCasesPerPallet: defaultMaxCasesPerPallet === '' ? null : defaultMaxCasesPerPallet,
        putawayAssignmentGraceMinutes: putawayAssignmentGraceMinutes === '' ? undefined : putawayAssignmentGraceMinutes,
        allowPutawayLocationOverride,
        abcReassessmentEnabled,
        abcClassAPercent,
        abcClassBPercent,
        abcClassCPercent,
        abcAssessmentWindowMonths,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(errorText(data, 'Could not save settings.'));
      return;
    }
    setSettings(data);
    setSaved(true);
  };

  // Regenerating is a separate action/endpoint from Save Settings
  // (2026-08-27, ERP push) — a new key is a real, deliberate act, not
  // something that should happen as a side effect of an unrelated form
  // save. Overwrites any existing key immediately, no "reveal old key"
  // path — same as any other API key regeneration flow.
  const handleRegenerateKey = async () => {
    if (settings?.erpApiKey && !confirm('This replaces the current key immediately — anything using the old one will stop working. Continue?')) return;
    setKeyError('');
    setRegenerating(true);
    const res = await fetch('http://localhost:3000/companies/settings/erp-api-key/regenerate', { method: 'PATCH', headers: authHeaders() });
    const data = await res.json();
    setRegenerating(false);
    if (!res.ok) {
      setKeyError(errorText(data, 'Could not generate a key.'));
      return;
    }
    setSettings((s) => (s ? { ...s, erpApiKey: data.erpApiKey } : s));
  };

  if (!settings) return <div style={{ maxWidth: 600, margin: '40px auto', fontFamily: 'sans-serif' }}>Loading...</div>;

  return (
    <div style={{ maxWidth: 600, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1 style={{ textAlign: 'center' }}>Company Settings</h1>
      <p style={{ textAlign: 'center', color: '#666', fontSize: 13, marginTop: -8 }}>{settings.name}</p>

      <div style={{ marginTop: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>Detention</h3>
        <p style={{ marginTop: -4, marginBottom: 16, fontSize: 13, color: '#888' }}>
          Detention cost is free for the first few hours, then this full amount is added for every complete 24-hour block after that (not prorated — a vehicle at 27 hours still owes ₹0 if it hasn't completed a full chargeable day yet) — a specific Vehicle or Vehicle Type can override the rate individually if you need finer control later, but most companies just use this one number for their whole fleet.
        </p>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 'bold' }}>Free hours (no cost before this)</label>
            <p style={{ margin: '0 0 4px', fontSize: 12, color: '#888' }}>How long a vehicle can dwell for free before detention cost starts counting at all.</p>
            <input value={detentionFreeHours} onChange={(e) => setDetentionFreeHours(e.target.value)} placeholder="e.g. 4" style={{ width: 200, padding: 6 }} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 'bold' }}>Detention Cost (₹ per 24 hours, after the free window)</label>
            <input value={detentionCostPerDay} onChange={(e) => setDetentionCostPerDay(e.target.value)} placeholder="e.g. 15000" style={{ width: 200, padding: 6 }} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 'bold' }}>Alert after (hours)</label>
            <p style={{ margin: '0 0 4px', fontSize: 12, color: '#888' }}>How long a vehicle can dwell before the assigned Warehouse Manager gets notified. Leave blank for no alerts.</p>
            <input value={detentionAlertHours} onChange={(e) => setDetentionAlertHours(e.target.value)} placeholder="e.g. 4" style={{ width: 200, padding: 6 }} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 'bold' }}>Escalate after (additional hours, unacknowledged)</label>
            <p style={{ margin: '0 0 4px', fontSize: 12, color: '#888' }}>If the alert above is still unacknowledged this many hours later, the Company Admin also gets notified. Leave blank for no escalation.</p>
            <input value={detentionEscalationHours} onChange={(e) => setDetentionEscalationHours(e.target.value)} placeholder="e.g. 8" style={{ width: 200, padding: 6 }} />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 'bold' }}>
              <input type="checkbox" checked={allowErpInboundPush} onChange={(e) => setAllowErpInboundPush(e.target.checked)} />
              Allow ERP to push Inbound orders
            </label>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#888' }}>
              A valid API key is still checked on every push even with this on — turning it off blocks pushes
              immediately without needing to touch the key itself.
            </p>
          </div>

          {error && <p style={{ color: 'crimson' }}>{error}</p>}
          {saved && <p style={{ color: 'green' }}>Saved.</p>}
          <button type="submit">Save Settings</button>
        </form>
      </div>

      <div style={{ marginTop: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>Putaway</h3>
        <p style={{ marginTop: -4, marginBottom: 16, fontSize: 13, color: '#888' }}>
          Controls when Putaway tasks get created. Immediate lets staff start putting away in parallel with
          unloading (a task is created as soon as material is accepted at staging); Batch waits until the whole
          vehicle is fully received first.
        </p>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 'bold' }}>Trigger Mode</label>
            <select value={putawayTriggerMode} onChange={(e) => setPutawayTriggerMode(e.target.value as 'BATCH' | 'IMMEDIATE')} style={{ width: 214, padding: 6 }}>
              <option value="IMMEDIATE">Immediate (as material is scanned in)</option>
              <option value="BATCH">Batch (once the whole vehicle is received)</option>
            </select>
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 'bold' }}>Immediate-mode batch size (optional)</label>
            <p style={{ margin: '0 0 4px', fontSize: 12, color: '#888' }}>
              Only used in Immediate mode. Leave blank so every accepted/approved scan becomes its own task right
              away (e.g. even 1 of 10 cases scanned can be put away immediately). Set a number to instead
              accumulate scans of the same SKU/line up to this quantity before a task is created — a specific SKU
              can override this company-wide number individually.
            </p>
            <input value={putawayDefaultBatchQty} onChange={(e) => setPutawayDefaultBatchQty(e.target.value)} placeholder="blank = every scan its own task" style={{ width: 200, padding: 6 }} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 'bold' }}>Default Max Cases Per Pallet (optional)</label>
            <p style={{ margin: '0 0 4px', fontSize: 12, color: '#888' }}>
              Pallet consolidation — when a receipt requires staff to marry loose cases onto a pallet before Putaway,
              a pallet's load auto-closes once it holds this many cases. A SKU can override this individually on SKU
              Master. Leave blank if only per-SKU overrides should apply — a pallet with no effective max can only be
              closed manually.
            </p>
            <input value={defaultMaxCasesPerPallet} onChange={(e) => setDefaultMaxCasesPerPallet(e.target.value)} placeholder="blank = SKU override or manual close only" style={{ width: 240, padding: 6 }} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 'bold' }}>Putaway Assignment Grace Minutes</label>
            <p style={{ margin: '0 0 4px', fontSize: 12, color: '#888' }}>
              How long the recommended (longest-free, MHE-capable) operator has to pick up the next Putaway task
              before the Warehouse Supervisor is notified. If their next turn also lapses by this same duration, it
              escalates to the Warehouse Manager. One dial, reused for both steps.
            </p>
            <input value={putawayAssignmentGraceMinutes} onChange={(e) => setPutawayAssignmentGraceMinutes(e.target.value)} placeholder="2" style={{ width: 100, padding: 6 }} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={allowPutawayLocationOverride} onChange={(e) => setAllowPutawayLocationOverride(e.target.checked)} style={{ marginTop: 3 }} />
              <span>
                <strong>Allow Putaway location override</strong>
                <br />
                <span style={{ color: '#888', fontSize: 12 }}>
                  Off by default: completing a trip only ever accepts a scan of the exact assigned bin. Turn this on to
                  let operators complete at a different real, active bin instead when the assigned one doesn't work —
                  any mismatch is flagged as a discrepancy for a Supervisor/Manager/Admin to review on the Putaway page.
                </span>
              </span>
            </label>
          </div>

          {error && <p style={{ color: 'crimson' }}>{error}</p>}
          {saved && <p style={{ color: 'green' }}>Saved.</p>}
          <button type="submit">Save Settings</button>
        </form>

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #eee' }}>
          <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 'bold' }}>Aging Methodology (per warehouse)</label>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: '#888' }}>
            How close two receiving dates need to be for the system to treat stock as the same batch when
            suggesting a bin. A tighter setting (Day) keeps different trips more separated; a looser one (Month)
            lets more stock consolidate into the same lane. This differs by warehouse, not company-wide — set it
            against each warehouse individually.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select value={agingWarehouseId} onChange={(e) => handleAgingWarehouseChange(e.target.value)} style={{ padding: 6, minWidth: 180 }}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
              ))}
            </select>
            <select value={agingGranularity} onChange={(e) => setAgingGranularity(e.target.value as 'DAY' | 'WEEK' | 'MONTH')} style={{ padding: 6, width: 140 }}>
              <option value="DAY">Day</option>
              <option value="WEEK">Week</option>
              <option value="MONTH">Month</option>
            </select>
            <button type="button" onClick={handleSaveAgingGranularity} disabled={agingSaving || !agingWarehouseId}>
              {agingSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
          {agingError && <p style={{ color: 'crimson', marginTop: 8 }}>{agingError}</p>}
          {agingSaved && <p style={{ color: 'green', marginTop: 8 }}>Saved.</p>}
        </div>

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #eee' }}>
          <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 'bold' }}>Dock Configuration (per warehouse)</label>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: '#888' }}>
            Tells Putaway which end of this warehouse's own Aisle order sits near an Inbound/Outbound/Both dock —
            fast movers (Class A/B) are placed near whichever end serves Outbound, slow movers (C/D) far from it. A
            warehouse with docks on one side only needs one zone (e.g. Outbound, near the Low-numbered aisles); one
            with docks on opposite ends (Inbound one side, Outbound the other) needs two. Leave empty to keep
            today's behavior (nearest to the lowest flank number, unrelated to real dock position).
          </p>
          <select value={dockZoneWarehouseId} onChange={(e) => handleDockZoneWarehouseChange(e.target.value)} style={{ padding: 6, minWidth: 180, marginBottom: 10 }}>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
            ))}
          </select>
          {dockZoneRows.map((row, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <select value={row.purpose} onChange={(e) => updateDockZoneRow(i, 'purpose', e.target.value)} style={{ padding: 6, width: 120 }}>
                <option value="INBOUND">Inbound</option>
                <option value="OUTBOUND">Outbound</option>
                <option value="BOTH">Both</option>
              </select>
              <span style={{ fontSize: 12, color: '#888' }}>near the</span>
              <select value={row.nearAisleEnd} onChange={(e) => updateDockZoneRow(i, 'nearAisleEnd', e.target.value)} style={{ padding: 6, width: 100 }}>
                <option value="LOW">Low</option>
                <option value="HIGH">High</option>
              </select>
              <span style={{ fontSize: 12, color: '#888' }}>end of the aisle order</span>
              <button type="button" onClick={() => removeDockZoneRow(i)} style={{ marginLeft: 'auto' }}>Remove</button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" onClick={addDockZoneRow} disabled={dockZoneRows.length >= 2}>+ Add zone</button>
            <button type="button" onClick={handleSaveDockZones} disabled={dockZoneSaving || !dockZoneWarehouseId}>
              {dockZoneSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
          {dockZoneError && <p style={{ color: 'crimson', marginTop: 8 }}>{dockZoneError}</p>}
          {dockZoneSaved && <p style={{ color: 'green', marginTop: 8 }}>Saved.</p>}
        </div>

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #eee' }}>
          <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 'bold' }}>Pick Face (per warehouse, SPR only)</label>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: '#888' }}>
            When on, a daily job keeps this warehouse's SPR "Pick Face" locations stocked with its
            highest-priority A/B-class SKUs — refilling an empty slot from reserve, or evicting a
            lower-class occupant for a higher one. Off by default; uses the same warehouse picker
            as Aging Methodology above.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select value={agingWarehouseId} onChange={(e) => handleAgingWarehouseChange(e.target.value)} style={{ padding: 6, minWidth: 180 }}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
              ))}
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={pickFaceEnabled} onChange={(e) => setPickFaceEnabled(e.target.checked)} />
              Enabled
            </label>
            <button type="button" onClick={handleSavePickFaceEnabled} disabled={pickFaceSaving || !agingWarehouseId}>
              {pickFaceSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
          {pickFaceError && <p style={{ color: 'crimson', marginTop: 8 }}>{pickFaceError}</p>}
          {pickFaceSaved && <p style={{ color: 'green', marginTop: 8 }}>Saved.</p>}
        </div>

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #eee' }}>
          <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 'bold' }}>Storage-Type SKU Sharing (per warehouse, per storage type)</label>
          <p style={{ margin: '0 0 8px', fontSize: 12, color: '#888' }}>
            How many distinct SKUs suggestBin() will let share one physical lane (Rack) or bin (Ground/Floor)
            for a given storage type + category — blank means no limit. For Ground/Floor bins, "respects
            column boundaries" additionally controls whether a column must stay single-SKU internally, or can
            mix different SKUs at different depths (off is the free-mixing "dead stock" default for Class D —
            any class can opt into it).
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <select value={capsWarehouseId} onChange={(e) => handleCapsWarehouseChange(e.target.value)} style={{ padding: 6, minWidth: 180 }}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
              ))}
            </select>
            <select value={capsRowId} onChange={(e) => handleCapsRowChange(e.target.value)} style={{ padding: 6, minWidth: 220 }}>
              {(warehouses.find((w) => w.id === capsWarehouseId)?.storageTypes || []).map((r) => (
                <option key={r.id} value={r.id}>{r.storageType} — {r.category?.name ?? 'Uncategorized'}</option>
              ))}
            </select>
          </div>
          {!capsRowId ? (
            <p style={{ fontSize: 13, color: '#888' }}>This warehouse has no storage-type rows to configure yet.</p>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontSize: 12 }}>Class A limit:</span>
                <input value={capsMaxA} onChange={(e) => setCapsMaxA(e.target.value)} placeholder="no limit" style={{ width: 90, padding: 6 }} />
                <span style={{ fontSize: 12 }}>Class B limit:</span>
                <input value={capsMaxB} onChange={(e) => setCapsMaxB(e.target.value)} placeholder="no limit" style={{ width: 90, padding: 6 }} />
                <span style={{ fontSize: 12 }}>Class C limit:</span>
                <input value={capsMaxC} onChange={(e) => setCapsMaxC(e.target.value)} placeholder="no limit" style={{ width: 90, padding: 6 }} />
              </div>
              {warehouses.find((w) => w.id === capsWarehouseId)?.storageTypes?.find((r) => r.id === capsRowId)?.storageType === 'GROUND_FLOOR' && (
                <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
                  <span style={{ fontSize: 12, color: '#888' }}>Respects column boundaries:</span>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
                    <input type="checkbox" checked={capsBoundaryA} onChange={(e) => setCapsBoundaryA(e.target.checked)} /> A
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
                    <input type="checkbox" checked={capsBoundaryB} onChange={(e) => setCapsBoundaryB(e.target.checked)} /> B
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
                    <input type="checkbox" checked={capsBoundaryC} onChange={(e) => setCapsBoundaryC(e.target.checked)} /> C
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
                    <input type="checkbox" checked={capsBoundaryD} onChange={(e) => setCapsBoundaryD(e.target.checked)} /> D
                  </label>
                </div>
              )}
              <button type="button" onClick={handleSaveStorageTypeCaps} disabled={capsSaving}>
                {capsSaving ? 'Saving...' : 'Save'}
              </button>
              {capsError && <p style={{ color: 'crimson', marginTop: 8 }}>{capsError}</p>}
              {capsSaved && <p style={{ color: 'green', marginTop: 8 }}>Saved.</p>}
            </>
          )}
        </div>
      </div>

      <div style={{ marginTop: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>ABC Velocity Reassessment</h3>
        <p style={{ marginTop: -4, marginBottom: 16, fontSize: 13, color: '#888' }}>
          A real monthly job (1st of every month, at night) re-derives each SKU's A/B/C class per warehouse from its
          own actual trailing dispatch quantity — never company-wide, since the same SKU can be a fast mover in one
          warehouse and barely move in another. Off by default; the manually-set/imported class on SKU Master stays
          the fallback until a warehouse has enough real history. See the "ABC Classification" page to run it on
          demand and see results.
        </p>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={abcReassessmentEnabled} onChange={(e) => setAbcReassessmentEnabled(e.target.checked)} />
              <strong>Enable monthly ABC reassessment</strong>
            </label>
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 'bold' }}>Class cutoffs (cumulative % of dispatched quantity)</label>
            <p style={{ margin: '0 0 4px', fontSize: 12, color: '#888' }}>
              Must add up to 100. E.g. 75/15/10 means the top SKUs making up 75% of a category's dispatched volume
              are Class A, the next 15% are B, the rest are C.
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12 }}>A:</span>
              <input value={abcClassAPercent} onChange={(e) => setAbcClassAPercent(e.target.value)} style={{ width: 60, padding: 6 }} />
              <span style={{ fontSize: 12 }}>B:</span>
              <input value={abcClassBPercent} onChange={(e) => setAbcClassBPercent(e.target.value)} style={{ width: 60, padding: 6 }} />
              <span style={{ fontSize: 12 }}>C:</span>
              <input value={abcClassCPercent} onChange={(e) => setAbcClassCPercent(e.target.value)} style={{ width: 60, padding: 6 }} />
              {(() => {
                const sum = [abcClassAPercent, abcClassBPercent, abcClassCPercent].reduce((s, v) => s + (Number(v) || 0), 0);
                return <span style={{ fontSize: 12, color: sum === 100 ? '#2e7d32' : 'crimson' }}>= {sum}{sum !== 100 ? ' (must be 100)' : ''}</span>;
              })()}
            </div>
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', marginBottom: 4, fontSize: 13, fontWeight: 'bold' }}>Assessment window (months)</label>
            <p style={{ margin: '0 0 4px', fontSize: 12, color: '#888' }}>
              How far back the ranking looks, and also the "no dispatch at all in this period" threshold that flags a
              SKU into a real 4th class, D (dead stock).
            </p>
            <input value={abcAssessmentWindowMonths} onChange={(e) => setAbcAssessmentWindowMonths(e.target.value)} style={{ width: 100, padding: 6 }} />
          </div>

          {error && <p style={{ color: 'crimson' }}>{error}</p>}
          {saved && <p style={{ color: 'green' }}>Saved.</p>}
          <button type="submit">Save Settings</button>
        </form>
      </div>

      <div style={{ marginTop: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>ERP Integration</h3>
        <p style={{ marginTop: -4, marginBottom: 16, fontSize: 13, color: '#888' }}>
          Your ERP (or whatever system pushes Inbound orders) authenticates with this key in an{' '}
          <code>X-Api-Key</code> header against <code>POST /erp/inbound-receipts</code>. Orders are matched by
          Warehouse Code and SKU Code — the same codes used everywhere else in this system.
        </p>
        {settings.erpApiKey ? (
          <p style={{ fontFamily: 'monospace', background: '#f5f5f5', padding: 8, borderRadius: 4, wordBreak: 'break-all' }}>{settings.erpApiKey}</p>
        ) : (
          <p style={{ color: '#888' }}>No key generated yet.</p>
        )}
        {keyError && <p style={{ color: 'crimson' }}>{keyError}</p>}
        <button type="button" onClick={handleRegenerateKey} disabled={regenerating}>
          {regenerating ? 'Generating...' : settings.erpApiKey ? 'Regenerate Key' : 'Generate Key'}
        </button>
      </div>
    </div>
  );
}

export default CompanySettingsPage;

import { useEffect, useState } from 'react';

// Combines Gate In/Out and Yard Management into one page — the client's
// explicit call ("both same, yard + gate in / gate out, security should
// have visibility together"), replacing the separate Vehicles/Drivers tabs
// entirely (2026-08-27): registration now happens only via the two buttons
// below, not a standalone page.

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
type Warehouse = { id: string; code: string; name: string };
type GateEntry = {
  id: string;
  warehouse: { id: string; code: string; name: string };
  vehicle: { id: string; vehicleNumber: string };
  driver: { id: string; name: string };
  purpose: string;
  transporterName?: string;
  referenceNo?: string;
  destinationCity?: string;
  yardSlot?: { id: string; code: string };
  gateInAt: string;
  gateInBy?: { name: string };
  gateOutAt?: string;
  gateOutBy?: { name: string };
  dockedInAt?: string;
  dockedInBy?: { name: string };
  eWayBillNo?: string;
  invoiceWeightKg?: number;
  materialReceivedConfirmed: boolean;
};
type YardSummaryRow = {
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  yardConfigured: boolean;
  totalSlots: number;
  occupied: number;
  available: number;
};
type TrackerRow = {
  gateEntryId: string;
  warehouse: { id: string; code: string; name: string };
  slotCode?: string;
  vehicleNumber: string;
  destinationCity?: string;
  transporterName?: string;
  gateInAt: string;
  dockedInAt?: string;
  status: 'IN_YARD' | 'DOCKED';
  hoursInParking: number;
  hoursInDock: number | null;
};

function authHeaders() {
  const token = localStorage.getItem('token');
  return { Authorization: `Bearer ${token}` };
}
function jsonHeaders() {
  return { 'Content-Type': 'application/json', ...authHeaders() };
}
function fmtDateTime(d?: string) {
  return d ? new Date(d).toLocaleString() : '—';
}
function fmtDate(d?: string) {
  return d ? new Date(d).toLocaleDateString() : '—';
}
function fmtHours(h: number | null | undefined) {
  if (h == null) return '—';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 24) return `${h.toFixed(1)} hr`;
  return `${Math.floor(h / 24)}d ${Math.round(h % 24)}h`;
}
function errorText(data: any, fallback: string) {
  return Array.isArray(data?.message) ? data.message.join(' | ') : data?.message || fallback;
}

const PURPOSE_LABELS: Record<string, string> = {
  INBOUND_DELIVERY: 'Inbound Delivery',
  OUTBOUND_DISPATCH: 'Outbound Dispatch',
  RETURNS: 'Returns',
};

// What's checked at Gate In — pulled from the Vehicle/Driver record, a
// simple "Confirmed OK" checkbox per document (unticked = Missing) rather
// than a 3-way selector, per the client's direct confirmation.
const DOCUMENT_DEFS: { type: string; label: string; source: 'vehicle' | 'driver'; numberField: string; expiryField: string }[] = [
  { type: 'RC', label: 'RC (Registration)', source: 'vehicle', numberField: 'rcNumber', expiryField: 'rcExpiry' },
  { type: 'INSURANCE', label: 'Insurance', source: 'vehicle', numberField: 'insuranceNumber', expiryField: 'insuranceExpiry' },
  { type: 'PUC', label: 'PUC (Pollution)', source: 'vehicle', numberField: 'pucNumber', expiryField: 'pucExpiry' },
  { type: 'FITNESS', label: 'Fitness Certificate', source: 'vehicle', numberField: 'fitnessNumber', expiryField: 'fitnessExpiry' },
  { type: 'LICENSE', label: "Driver's License", source: 'driver', numberField: 'licenseNumber', expiryField: 'licenseExpiry' },
];

const emptyGateInForm = {
  warehouseId: '', vehicleId: '', driverId: '', purpose: '', transporterName: '', referenceNo: '', destinationCity: '', grossWeightKg: '',
};
const emptyVehicleForm = {
  vehicleNumber: '', vehicleTypeId: '', lengthFt: '', widthFt: '', heightFt: '', maxTonnage: '',
  rcNumber: '', rcExpiry: '', insuranceNumber: '', insuranceExpiry: '', pucNumber: '', pucExpiry: '', fitnessNumber: '', fitnessExpiry: '',
  isBlacklisted: false, blacklistReason: '',
};
const emptyDriverForm = { name: '', phone: '', licenseNumber: '', licenseExpiry: '', isBlacklisted: false, blacklistReason: '' };
const emptyGateOutForm = { tareWeightKg: '', eWayBillNo: '', invoiceWeightKg: '', materialReceivedConfirmed: false };

function GateYardPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [vehicleTypes, setVehicleTypes] = useState<VehicleType[]>([]);
  const [yardSummary, setYardSummary] = useState<YardSummaryRow[]>([]);
  const [tracker, setTracker] = useState<TrackerRow[]>([]);
  const [history, setHistory] = useState<GateEntry[]>([]);

  const [showGateInForm, setShowGateInForm] = useState(false);
  const [gateInForm, setGateInForm] = useState(emptyGateInForm);
  const [vehicleText, setVehicleText] = useState('');
  const [driverText, setDriverText] = useState('');
  const [documentConfirmed, setDocumentConfirmed] = useState<Record<string, boolean>>({});
  const [gateInError, setGateInError] = useState('');

  const [showVehicleModal, setShowVehicleModal] = useState(false);
  const [vehicleForm, setVehicleForm] = useState(emptyVehicleForm);
  const [vehicleFormError, setVehicleFormError] = useState('');

  const [showDriverModal, setShowDriverModal] = useState(false);
  const [driverForm, setDriverForm] = useState(emptyDriverForm);
  const [driverFormError, setDriverFormError] = useState('');

  const [gateOutFor, setGateOutFor] = useState<GateEntry | null>(null);
  const [gateOutForm, setGateOutForm] = useState(emptyGateOutForm);
  const [gateOutError, setGateOutError] = useState('');

  const [showOpenList, setShowOpenList] = useState(true);
  const [showHistoryList, setShowHistoryList] = useState(false);
  const [historySearch, setHistorySearch] = useState('');
  const [historyFrom, setHistoryFrom] = useState('');
  const [historyTo, setHistoryTo] = useState('');

  const loadWarehouses = () => fetch('http://localhost:3000/warehouses', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setWarehouses(Array.isArray(d) ? d : []));
  const loadVehicles = () => fetch('http://localhost:3000/vehicles', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setVehicles(Array.isArray(d) ? d : []));
  const loadDrivers = () => fetch('http://localhost:3000/drivers', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setDrivers(Array.isArray(d) ? d : []));
  const loadVehicleTypes = () => fetch('http://localhost:3000/vehicle-types', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setVehicleTypes(Array.isArray(d) ? d : []));
  const loadYardSummary = () => fetch('http://localhost:3000/yard/summary', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setYardSummary(Array.isArray(d) ? d : []));
  const loadTracker = () => fetch('http://localhost:3000/yard/tracker', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setTracker(Array.isArray(d) ? d : []));
  const loadHistory = () => fetch('http://localhost:3000/gate-entries', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setHistory(Array.isArray(d) ? d : []));

  const loadAll = () => {
    loadWarehouses(); loadVehicles(); loadDrivers(); loadVehicleTypes(); loadYardSummary(); loadTracker(); loadHistory();
  };

  useEffect(() => { loadAll(); }, []);

  // Default to the user's only warehouse if they have exactly one — the
  // dropdown already only ever lists what GET /warehouses scopes them to.
  useEffect(() => {
    if (warehouses.length === 1 && !gateInForm.warehouseId) {
      setGateInForm((f) => ({ ...f, warehouseId: warehouses[0].id }));
    }
  }, [warehouses]);

  // Yard-full banner — shown before submit, not as a popup after.
  const yardRowForForm = yardSummary.find((s) => s.warehouseId === gateInForm.warehouseId);
  const yardFullBanner = yardRowForForm?.yardConfigured && yardRowForForm.available === 0
    ? `⚠ Yard is at full capacity at ${yardRowForForm.warehouseCode} (${yardRowForForm.occupied}/${yardRowForForm.totalSlots} slots occupied). This vehicle may gate in without a parking slot.`
    : '';

  const selectedVehicle = vehicles.find((v) => v.id === gateInForm.vehicleId);
  const selectedDriver = drivers.find((d) => d.id === gateInForm.driverId);

  const resetGateInForm = () => {
    setGateInForm(emptyGateInForm);
    setVehicleText('');
    setDriverText('');
    setDocumentConfirmed({});
    setGateInError('');
    setShowGateInForm(false);
  };

  const handleVehicleTextChange = (text: string) => {
    setVehicleText(text);
    const match = vehicles.find((v) => v.vehicleNumber === text);
    setGateInForm((f) => ({ ...f, vehicleId: match ? match.id : '' }));
  };
  const handleDriverTextChange = (text: string) => {
    setDriverText(text);
    const match = drivers.find((d) => `${d.name}${d.phone ? ` (${d.phone})` : ''}` === text);
    setGateInForm((f) => ({ ...f, driverId: match ? match.id : '' }));
  };

  const handleGateInSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setGateInError('');
    const documentChecks = DOCUMENT_DEFS.map((d) => ({ documentType: d.type, status: documentConfirmed[d.type] ? 'OK' : 'MISSING' }));
    const res = await fetch('http://localhost:3000/gate-entries', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ ...gateInForm, grossWeightKg: gateInForm.grossWeightKg || undefined, documentChecks }),
    });
    const data = await res.json();
    if (!res.ok) {
      setGateInError(errorText(data, 'Could not log this vehicle in.'));
      return;
    }
    if (data.yardFullWarning) {
      alert('Note: the yard is at full capacity — no parking slot was assigned to this vehicle.');
    }
    resetGateInForm();
    loadTracker(); loadYardSummary(); loadHistory();
  };

  const handleVehicleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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
    const res = await fetch('http://localhost:3000/vehicles', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) {
      setVehicleFormError(errorText(data, 'Could not register this vehicle.'));
      return;
    }
    setVehicleForm(emptyVehicleForm);
    setShowVehicleModal(false);
    await loadVehicles();
    // Convenience: if the Gate In form is open, select the vehicle just registered.
    setVehicleText(data.vehicleNumber);
    setGateInForm((f) => ({ ...f, vehicleId: data.id }));
  };

  const handleDriverSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setDriverFormError('');
    const body = { ...driverForm, licenseExpiry: driverForm.licenseExpiry || undefined };
    const res = await fetch('http://localhost:3000/drivers', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) {
      setDriverFormError(errorText(data, 'Could not register this driver.'));
      return;
    }
    setDriverForm(emptyDriverForm);
    setShowDriverModal(false);
    await loadDrivers();
    setDriverText(`${data.name}${data.phone ? ` (${data.phone})` : ''}`);
    setGateInForm((f) => ({ ...f, driverId: data.id }));
  };

  const openGateOut = (entry: GateEntry) => {
    setGateOutFor(entry);
    setGateOutForm(emptyGateOutForm);
    setGateOutError('');
  };

  const handleGateOutSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!gateOutFor) return;
    setGateOutError('');
    const body: any = { tareWeightKg: gateOutForm.tareWeightKg || undefined };
    if (gateOutFor.purpose === 'OUTBOUND_DISPATCH') {
      body.eWayBillNo = gateOutForm.eWayBillNo || undefined;
      body.invoiceWeightKg = gateOutForm.invoiceWeightKg || undefined;
    } else if (gateOutFor.purpose === 'INBOUND_DELIVERY') {
      body.materialReceivedConfirmed = gateOutForm.materialReceivedConfirmed;
    }
    const res = await fetch(`http://localhost:3000/gate-entries/${gateOutFor.id}/gate-out`, { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) {
      setGateOutError(errorText(data, 'Could not gate this vehicle out.'));
      return;
    }
    setGateOutFor(null);
    loadTracker(); loadYardSummary(); loadHistory();
  };

  const handleDockIn = async (id: string) => {
    const res = await fetch(`http://localhost:3000/gate-entries/${id}/dock-in`, { method: 'PATCH', headers: authHeaders() });
    if (!res.ok) {
      const data = await res.json();
      alert(errorText(data, 'Could not mark this vehicle docked in.'));
      return;
    }
    loadTracker(); loadYardSummary();
  };

  const handleExport = () => {
    fetch('http://localhost:3000/gate-entries/export', { headers: authHeaders() })
      .then((res) => res.blob())
      .then((blob) => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'Gate_Entries_Export.xlsx';
        a.click();
        window.URL.revokeObjectURL(url);
      });
  };

  const filteredHistory = history.filter((e) => {
    const q = historySearch.toLowerCase();
    const matchesSearch = !q || e.vehicle.vehicleNumber.toLowerCase().includes(q) || e.driver.name.toLowerCase().includes(q) || e.warehouse.code.toLowerCase().includes(q);
    const gateInDate = e.gateInAt.slice(0, 10);
    const matchesFrom = !historyFrom || gateInDate >= historyFrom;
    const matchesTo = !historyTo || gateInDate <= historyTo;
    return matchesSearch && matchesFrom && matchesTo;
  });

  return (
    <div style={{ maxWidth: 1200, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1 style={{ textAlign: 'center' }}>Gate &amp; Yard Management</h1>

      <div style={{ marginBottom: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" onClick={() => (showGateInForm ? resetGateInForm() : setShowGateInForm(true))}>
          {showGateInForm ? '▾ Hide Gate In form' : '▸ + Gate In'}
        </button>
        <button type="button" onClick={() => setShowVehicleModal(true)}>Register Vehicle</button>
        <button type="button" onClick={() => setShowDriverModal(true)}>Register Driver</button>
      </div>

      {showGateInForm && (
        <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>Gate In</h3>
          <form onSubmit={handleGateInSubmit}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <select value={gateInForm.warehouseId} onChange={(e) => setGateInForm({ ...gateInForm, warehouseId: e.target.value })} required style={{ width: 220 }}>
                <option value="">Warehouse *</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
                ))}
              </select>
              <select value={gateInForm.purpose} onChange={(e) => setGateInForm({ ...gateInForm, purpose: e.target.value })} required style={{ width: 180 }}>
                <option value="">Purpose *</option>
                {Object.entries(PURPOSE_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
            </div>

            {yardFullBanner && <p style={{ background: '#fff3cd', border: '1px solid #ffe08a', padding: 8, borderRadius: 6 }}>{yardFullBanner}</p>}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <div>
                <input
                  list="vehicle-options"
                  placeholder="Vehicle Number * (type to search)"
                  value={vehicleText}
                  onChange={(e) => handleVehicleTextChange(e.target.value)}
                  required
                  style={{ width: 220 }}
                />
                <datalist id="vehicle-options">
                  {vehicles.map((v) => (
                    <option key={v.id} value={v.vehicleNumber} />
                  ))}
                </datalist>
              </div>
              <div>
                <input
                  list="driver-options"
                  placeholder="Driver * (type to search)"
                  value={driverText}
                  onChange={(e) => handleDriverTextChange(e.target.value)}
                  required
                  style={{ width: 220 }}
                />
                <datalist id="driver-options">
                  {drivers.map((d) => (
                    <option key={d.id} value={`${d.name}${d.phone ? ` (${d.phone})` : ''}`} />
                  ))}
                </datalist>
              </div>
            </div>

            {(selectedVehicle?.isBlacklisted || selectedDriver?.isBlacklisted) && (
              <p style={{ color: 'crimson' }}>
                ⚠ {selectedVehicle?.isBlacklisted ? `Vehicle is blacklisted: ${selectedVehicle.blacklistReason}. ` : ''}
                {selectedDriver?.isBlacklisted ? `Driver is blacklisted: ${selectedDriver.blacklistReason}.` : ''}
              </p>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <input placeholder="Transporter Name" value={gateInForm.transporterName} onChange={(e) => setGateInForm({ ...gateInForm, transporterName: e.target.value })} style={{ width: 180 }} />
              <input placeholder="Reference No" value={gateInForm.referenceNo} onChange={(e) => setGateInForm({ ...gateInForm, referenceNo: e.target.value })} style={{ width: 150 }} />
              <input placeholder="Destination City" value={gateInForm.destinationCity} onChange={(e) => setGateInForm({ ...gateInForm, destinationCity: e.target.value })} style={{ width: 150 }} />
              <input placeholder="Gross Weight (kg)" value={gateInForm.grossWeightKg} onChange={(e) => setGateInForm({ ...gateInForm, grossWeightKg: e.target.value })} style={{ width: 140 }} />
            </div>

            {(selectedVehicle || selectedDriver) && (
              <div style={{ marginBottom: 12 }}>
                <p style={{ marginBottom: 4, fontWeight: 'bold' }}>Document Check — confirm each after physically checking it:</p>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ textAlign: 'center', borderBottom: '1px solid #ccc' }}>
                      <th style={{ padding: 6 }}>Document</th>
                      <th style={{ padding: 6 }}>Number</th>
                      <th style={{ padding: 6 }}>Expiry</th>
                      <th style={{ padding: 6 }}>Confirmed OK</th>
                    </tr>
                  </thead>
                  <tbody>
                    {DOCUMENT_DEFS.map((d) => {
                      const rec: any = d.source === 'vehicle' ? selectedVehicle : selectedDriver;
                      const number = rec?.[d.numberField];
                      const expiry = rec?.[d.expiryField];
                      const isExpired = expiry ? new Date(expiry) < new Date() : false;
                      return (
                        <tr key={d.type} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
                          <td style={{ padding: 6 }}>{d.label}</td>
                          <td style={{ padding: 6 }}>{number || 'Not on file'}</td>
                          <td style={{ padding: 6, color: isExpired ? 'crimson' : undefined }}>{expiry ? fmtDate(expiry) + (isExpired ? ' (EXPIRED)' : '') : '—'}</td>
                          <td style={{ padding: 6 }}>
                            <input
                              type="checkbox"
                              checked={!!documentConfirmed[d.type]}
                              onChange={(e) => setDocumentConfirmed({ ...documentConfirmed, [d.type]: e.target.checked })}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {gateInError && <p style={{ color: 'crimson' }}>{gateInError}</p>}
            <div>
              <button type="submit">Gate In</button>
              <button type="button" onClick={resetGateInForm} style={{ marginLeft: 8 }}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {/* Register Vehicle modal */}
      {showVehicleModal && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <h3 style={{ marginTop: 0 }}>Register Vehicle</h3>
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
              {/* One row per document — a native <input type="date"> shows no
                  label of its own, so packing two documents' Number+Expiry
                  pairs into one row made it unclear which date belonged to
                  which document (caught by the client, 2026-08-27). Each
                  document now gets its own labeled row instead. */}
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
                <button type="submit">Register Vehicle</button>
                <button type="button" onClick={() => { setShowVehicleModal(false); setVehicleForm(emptyVehicleForm); setVehicleFormError(''); }} style={{ marginLeft: 8 }}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Register Driver modal */}
      {showDriverModal && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <h3 style={{ marginTop: 0 }}>Register Driver</h3>
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
                <button type="submit">Register Driver</button>
                <button type="button" onClick={() => { setShowDriverModal(false); setDriverForm(emptyDriverForm); setDriverFormError(''); }} style={{ marginLeft: 8 }}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Gate Out modal */}
      {gateOutFor && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <h3 style={{ marginTop: 0 }}>Gate Out — {gateOutFor.vehicle.vehicleNumber}</h3>
            <p style={{ marginTop: -8, color: '#666' }}>{PURPOSE_LABELS[gateOutFor.purpose]}</p>
            <form onSubmit={handleGateOutSubmit}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                <input placeholder="Tare Weight (kg)" value={gateOutForm.tareWeightKg} onChange={(e) => setGateOutForm({ ...gateOutForm, tareWeightKg: e.target.value })} style={{ width: 150 }} />
              </div>
              {gateOutFor.purpose === 'OUTBOUND_DISPATCH' && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                  <input placeholder="Invoice Weight (kg) *" value={gateOutForm.invoiceWeightKg} onChange={(e) => setGateOutForm({ ...gateOutForm, invoiceWeightKg: e.target.value })} style={{ width: 160 }} />
                  <input placeholder="E-Way Bill No" value={gateOutForm.eWayBillNo} onChange={(e) => setGateOutForm({ ...gateOutForm, eWayBillNo: e.target.value })} style={{ width: 160 }} />
                </div>
              )}
              {gateOutFor.purpose === 'INBOUND_DELIVERY' && (
                <div style={{ marginBottom: 12 }}>
                  <label>
                    <input type="checkbox" checked={gateOutForm.materialReceivedConfirmed} onChange={(e) => setGateOutForm({ ...gateOutForm, materialReceivedConfirmed: e.target.checked })} /> All material received/scanned confirmed
                  </label>
                </div>
              )}
              {gateOutError && <p style={{ color: 'crimson' }}>{gateOutError}</p>}
              <div>
                <button type="submit">Gate Out</button>
                <button type="button" onClick={() => setGateOutFor(null)} style={{ marginLeft: 8 }}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Yard stat boxes */}
      <h2 style={{ marginBottom: 8 }}>Yard Status</h2>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 32 }}>
        {yardSummary.length === 0 && <p>No warehouses to show.</p>}
        {yardSummary.map((s) =>
          s.yardConfigured ? (
            <div key={s.warehouseId} style={{ ...cardStyle, minWidth: 220 }}>
              <div style={{ fontWeight: 'bold', marginBottom: 4 }}>{s.warehouseCode}</div>
              <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
                <div><strong>{s.totalSlots}</strong><div style={{ fontSize: 12 }}>Total</div></div>
                <div><strong>{s.occupied}</strong><div style={{ fontSize: 12 }}>Occupied</div></div>
                <div><strong>{s.available}</strong><div style={{ fontSize: 12 }}>Available</div></div>
              </div>
            </div>
          ) : (
            <div key={s.warehouseId} style={{ ...cardStyle, minWidth: 220, color: '#888' }}>
              <div style={{ fontWeight: 'bold', marginBottom: 4 }}>{s.warehouseCode}</div>
              <div>No parking configured</div>
            </div>
          ),
        )}
      </div>

      {/* Open entries — the working table */}
      <h2 style={{ marginBottom: 8, cursor: 'pointer', userSelect: 'none' }} onClick={() => setShowOpenList(!showOpenList)}>
        {showOpenList ? '▾' : '▸'} Currently Open (In Yard / Docked)
      </h2>
      {showOpenList && (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 32 }}>
          <thead>
            <tr style={{ textAlign: 'center', borderBottom: '2px solid #ccc' }}>
              <th style={{ padding: 8 }}>Status</th>
              <th style={{ padding: 8 }}>Slot</th>
              <th style={{ padding: 8 }}>Warehouse</th>
              <th style={{ padding: 8 }}>Vehicle</th>
              <th style={{ padding: 8 }}>Destination</th>
              <th style={{ padding: 8 }}>Transporter</th>
              <th style={{ padding: 8 }}>Gate In At</th>
              <th style={{ padding: 8 }}>Hrs in Parking</th>
              <th style={{ padding: 8 }}>Hrs in Dock</th>
              <th style={{ padding: 8 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tracker.map((r) => {
              const fullEntry = history.find((e) => e.id === r.gateEntryId);
              return (
                <tr key={r.gateEntryId} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: 8 }}>{r.status === 'DOCKED' ? 'Docked' : 'In Yard'}</td>
                  <td style={{ padding: 8 }}>{r.slotCode || '—'}</td>
                  <td style={{ padding: 8 }}>{r.warehouse.code}</td>
                  <td style={{ padding: 8, fontWeight: 'bold' }}>{r.vehicleNumber}</td>
                  <td style={{ padding: 8 }}>{r.destinationCity || '—'}</td>
                  <td style={{ padding: 8 }}>{r.transporterName || '—'}</td>
                  <td style={{ padding: 8 }}>{fmtDateTime(r.gateInAt)}</td>
                  <td style={{ padding: 8 }}>{fmtHours(r.hoursInParking)}</td>
                  <td style={{ padding: 8 }}>{fmtHours(r.hoursInDock)}</td>
                  <td style={{ padding: 8, whiteSpace: 'nowrap' }}>
                    {r.status === 'IN_YARD' && <button onClick={() => handleDockIn(r.gateEntryId)}>Mark Docked In</button>}
                    {fullEntry && <button onClick={() => openGateOut(fullEntry)} style={{ marginLeft: 6 }}>Gate Out</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {showOpenList && tracker.length === 0 && <p style={{ marginTop: -16, marginBottom: 32 }}>No vehicles currently in the yard or docked.</p>}

      {/* Full history */}
      <h2 style={{ marginBottom: 8, cursor: 'pointer', userSelect: 'none' }} onClick={() => setShowHistoryList(!showHistoryList)}>
        {showHistoryList ? '▾' : '▸'} List of All Gate Entries
      </h2>
      {showHistoryList && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16, alignItems: 'center', justifyContent: 'center' }}>
            <input placeholder="Search vehicle, driver, warehouse..." value={historySearch} onChange={(e) => setHistorySearch(e.target.value)} style={{ width: 260, padding: 8 }} />
            <label>From <input type="date" value={historyFrom} onChange={(e) => setHistoryFrom(e.target.value)} /></label>
            <label>To <input type="date" value={historyTo} onChange={(e) => setHistoryTo(e.target.value)} /></label>
            <button onClick={handleExport}>Export to Excel</button>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 32 }}>
            <thead>
              <tr style={{ textAlign: 'center', borderBottom: '2px solid #ccc' }}>
                <th style={{ padding: 8 }}>Vehicle</th>
                <th style={{ padding: 8 }}>Driver</th>
                <th style={{ padding: 8 }}>Purpose</th>
                <th style={{ padding: 8 }}>Warehouse</th>
                <th style={{ padding: 8 }}>Gate In At</th>
                <th style={{ padding: 8 }}>Gate Out At</th>
                <th style={{ padding: 8 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredHistory.map((e) => (
                <tr key={e.id} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: 8, fontWeight: 'bold' }}>{e.vehicle.vehicleNumber}</td>
                  <td style={{ padding: 8 }}>{e.driver.name}</td>
                  <td style={{ padding: 8 }}>{PURPOSE_LABELS[e.purpose] || e.purpose}</td>
                  <td style={{ padding: 8 }}>{e.warehouse.code}</td>
                  <td style={{ padding: 8 }}>{fmtDateTime(e.gateInAt)}</td>
                  <td style={{ padding: 8 }}>{e.gateOutAt ? fmtDateTime(e.gateOutAt) : '—'}</td>
                  <td style={{ padding: 8 }}>{e.gateOutAt ? 'Gated Out' : e.dockedInAt ? 'Docked' : 'In Yard'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredHistory.length === 0 && <p style={{ marginTop: -16 }}>No gate entries found.</p>}
        </>
      )}
    </div>
  );
}

export default GateYardPage;

const cardStyle: React.CSSProperties = {
  border: '1px solid #ccc',
  borderRadius: 8,
  padding: '12px 16px',
  textAlign: 'center',
  minWidth: 100,
};
const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
};
const modalStyle: React.CSSProperties = {
  background: '#fff', padding: 24, borderRadius: 8, maxWidth: 560, width: '90%', maxHeight: '90vh', overflowY: 'auto',
};

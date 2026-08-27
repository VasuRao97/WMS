import { useEffect, useRef, useState } from 'react';

// The Inbound team's whole workspace (2026-08-27) — the "order maker" plus
// everything that happens once a vehicle is actually here: Dock In (physical
// condition + seal), matching it to a real order, and scan-based receiving.
// Deliberately NOT on Gate & Yard — the client's own call: "this cant be in
// the yard management page at all," since the inbound/warehouse team who
// does receiving is a different audience than the security/gate staff that
// page is for (matches the vehicle-ready notification, which already only
// ever targeted Supervisors/Managers, never Security Supervisor). Gate &
// Yard still does Gate In, dock assignment, and Gate Out for every
// direction — only the inbound-specific middle of the flow lives here.

type Warehouse = { id: string; code: string; name: string };
type Sku = { id: string; code: string; description: string };
type Location = { id: string; code: string; warehouseId: string };
type Vehicle = { id: string; vehicleNumber: string };
type DockDoor = { id: string; warehouseId: string; code: string; defaultStagingLocation?: { id: string; code: string } };
type ReceiptLine = { id: string; sku: Sku; expectedQty: number; receivedQty: number; stagingLocation?: Location };
type Receipt = {
  id: string;
  warehouse: Warehouse;
  referenceNo: string;
  supplierName?: string;
  // The order's own expected vehicle (2026-08-27, the 1:1-mapping
  // follow-up) — required on every order now, distinct from gateEntry.
  // vehicle below (whichever real gate visit ended up matched).
  vehicle?: Vehicle;
  // True only for an order created via the ERP push endpoint (2026-08-27)
  // — shown as a small badge so staff can tell at a glance why an order
  // has no vehicle yet (it's not a mistake, it's the ERP's own design).
  createdViaErpPush?: boolean;
  status: 'PENDING' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'PUTAWAY_COMPLETE';
  stagingLocation?: Location;
  createdBy?: { name: string };
  createdAt: string;
  lines: ReceiptLine[];
  gateEntry?: { id: string; vehicle: { vehicleNumber: string }; dockedInAt?: string; gateOutAt?: string } | null;
};
type InboundScan = {
  id: string;
  barcodeScanned: string;
  skuId?: string;
  sku?: { code: string; description: string };
  receiptLineId?: string;
  quantity?: number;
  status: 'ACCEPTED' | 'BLOCKED' | 'APPROVED' | 'REJECTED';
  blockReason?: string;
  scannedBy?: { name: string };
  scannedAt: string;
  reviewedBy?: { name: string };
};
type GateEntry = {
  id: string;
  warehouse: { id: string; code: string; name: string };
  vehicle: { id: string; vehicleNumber: string };
  driver: { id: string; name: string };
  purpose: string;
  gateInAt: string;
  gateOutAt?: string;
  dockedInAt?: string;
  // Used to pre-fill Match Order's staging location from the dock's own
  // default (2026-08-27, live-testing follow-up) — string-matched against
  // DockDoor.code, not a real FK (assignedDockNumber stays free text).
  assignedDockNumber?: string;
  physicalConditionOk?: boolean | null;
  physicalConditionRemarks?: string;
  sealNumber?: string;
  sealSignatureData?: string;
  inboundReceiptId?: string;
  inboundReceipt?: {
    id: string;
    referenceNo: string;
    status: string;
    stagingLocation?: { id: string; code: string };
    lines: { id: string; sku: { id: string; code: string; description: string }; expectedQty: number; receivedQty: number }[];
  };
  inboundScans?: InboundScan[];
  // "Complete Inward Process" (2026-08-27) — the deliberate close-out
  // sign-off, distinct from the receipt simply reaching RECEIVED. This is
  // the real Gate Out gate now, not just receipt status.
  inwardCompletedAt?: string;
  inwardCompletedBy?: { name: string };
  inwardCompletionRemarks?: string;
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

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pending',
  PARTIALLY_RECEIVED: 'Partially Received',
  RECEIVED: 'Received',
  PUTAWAY_COMPLETE: 'Putaway Complete',
};

const emptyLine = { skuId: '', skuText: '', expectedQty: '', stagingLocationId: '' };
const emptyForm = { warehouseId: '', referenceNo: '', supplierName: '', vehicleId: '', vehicleText: '' };
// physicalConditionOk stays `null` until picked — distinct from "left
// unset," same reasoning as the schema field itself.
const emptyDockInForm = { physicalConditionOk: null as boolean | null, physicalConditionRemarks: '', sealNumber: '', sealSignatureData: '' };

// Simple canvas signature pad — same component as GateYardPage.tsx's (this
// codebase has no shared component library, so it's duplicated per page
// rather than imported cross-file, matching the existing convention).
function SignaturePad({ value, onChange }: { value: string; onChange: (dataUrl: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);

  const getPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    drawingRef.current = true;
    const { x, y } = getPos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const { x, y } = getPos(e);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#000';
    ctx.lineTo(x, y);
    ctx.stroke();
  };
  const handlePointerUp = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    if (canvasRef.current) onChange(canvasRef.current.toDataURL('image/png'));
  };
  const handleClear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    onChange('');
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={300}
        height={120}
        style={{ border: '1px solid #ccc', borderRadius: 4, touchAction: 'none', background: '#fff', display: 'block' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      />
      <div style={{ fontSize: 12, marginTop: 4 }}>
        <button type="button" onClick={handleClear}>Clear Signature</button>
        {value && <span style={{ marginLeft: 8, color: 'green' }}>✓ Signature captured</span>}
      </div>
    </div>
  );
}

function InboundOrdersPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [skus, setSkus] = useState<Sku[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [dockDoors, setDockDoors] = useState<DockDoor[]>([]);
  // Per-row typed text for the "Assign Vehicle" action on a vehicle-less
  // (ERP-pushed) order in the All Orders table — 2026-08-27, ERP push.
  const [assignVehicleInputs, setAssignVehicleInputs] = useState<Record<string, string>>({});
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [gateEntries, setGateEntries] = useState<GateEntry[]>([]);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [lines, setLines] = useState([{ ...emptyLine }]);
  const [formError, setFormError] = useState('');
  const [search, setSearch] = useState('');

  // Excel bulk import (2026-08-27, Inbound deep-dive conversation) — an
  // alternative to the still-unbuilt ERP push. One file can create multiple
  // orders (rows grouped by Warehouse Code + Reference No), same pattern as
  // Warehouse/Location's own import UI.
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ totalOrders: number; successCount: number; failCount: number; results: any[] } | null>(null);

  // Dock In (physical condition + seal) — moved here from Gate & Yard,
  // Inbound only (2026-08-27).
  const [dockInFor, setDockInFor] = useState<GateEntry | null>(null);
  const [dockInForm, setDockInForm] = useState(emptyDockInForm);
  const [dockInError, setDockInError] = useState('');

  // Match Order — auto-found by vehicle (2026-08-27, the 1:1-mapping
  // follow-up; no PO/Invoice number typed here anymore), entered after
  // Dock In, plus the staging location for this whole delivery.
  const [matchOrderFor, setMatchOrderFor] = useState<GateEntry | null>(null);
  const [matchOrderStagingLocationId, setMatchOrderStagingLocationId] = useState('');
  const [matchOrderError, setMatchOrderError] = useState('');

  // Receiving — scan-by-scan, capture universal / interpretation tiered.
  const [receivingFor, setReceivingFor] = useState<GateEntry | null>(null);
  const [scanInput, setScanInput] = useState('');
  const [scanError, setScanError] = useState('');
  const [approveForms, setApproveForms] = useState<Record<string, { receiptLineId: string; quantity: string }>>({});

  // "Complete Inward Process" (2026-08-27) — the deliberate close-out,
  // enabled only once the matched order is fully RECEIVED.
  const [completeInwardRemarks, setCompleteInwardRemarks] = useState('');
  const [completeInwardError, setCompleteInwardError] = useState('');

  const loadGateEntries = () => fetch('http://localhost:3000/gate-entries', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setGateEntries(Array.isArray(d) ? d : []));

  const load = () => {
    fetch('http://localhost:3000/warehouses', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setWarehouses(Array.isArray(d) ? d : []));
    fetch('http://localhost:3000/skus', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setSkus(Array.isArray(d) ? d : []));
    fetch('http://localhost:3000/locations', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setLocations(Array.isArray(d) ? d : []));
    fetch('http://localhost:3000/vehicles', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setVehicles(Array.isArray(d) ? d : []));
    fetch('http://localhost:3000/dock-doors', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setDockDoors(Array.isArray(d) ? d : []));
    fetch('http://localhost:3000/inbound-receipts', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setReceipts(Array.isArray(d) ? d : []));
    loadGateEntries();
  };
  useEffect(() => { load(); }, []);

  const locationsForWarehouse = locations.filter((l) => l.warehouseId === form.warehouseId);

  const resetForm = () => {
    setForm(emptyForm);
    setLines([{ ...emptyLine }]);
    setFormError('');
    setShowForm(false);
  };

  const updateLine = (i: number, patch: Partial<typeof emptyLine>) => {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  };
  const handleSkuTextChange = (i: number, text: string) => {
    const match = skus.find((s) => `${s.code} — ${s.description}` === text);
    updateLine(i, { skuText: text, skuId: match ? match.id : '' });
  };
  // Same plain <input list>+<datalist> pattern as GateYardPage.tsx's
  // Vehicle/Driver pickers — no exact match leaves vehicleId unresolved
  // rather than silently guessing (caught server-side as "Vehicle is
  // required" if submitted anyway).
  const handleVehicleTextChange = (text: string) => {
    const match = vehicles.find((v) => v.vehicleNumber === text);
    setForm({ ...form, vehicleText: text, vehicleId: match ? match.id : '' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    const body = {
      ...form,
      lines: lines.filter((l) => l.skuId || l.expectedQty || l.stagingLocationId).map((l) => ({ skuId: l.skuId, expectedQty: l.expectedQty, stagingLocationId: l.stagingLocationId })),
    };
    const res = await fetch('http://localhost:3000/inbound-receipts', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) {
      setFormError(errorText(data, 'Could not create this order.'));
      return;
    }
    resetForm();
    load();
  };

  const handleImport = async () => {
    if (!importFile) return;
    setImporting(true);
    setImportResult(null);
    const formData = new FormData();
    formData.append('file', importFile);
    const res = await fetch('http://localhost:3000/inbound-receipts/import', { method: 'POST', headers: authHeaders(), body: formData });
    const data = await res.json();
    setImportResult(data);
    setImporting(false);
    setImportFile(null);
    load();
  };

  const filtered = receipts.filter((r) => {
    const q = search.toLowerCase();
    return !q || r.referenceNo.toLowerCase().includes(q) || (r.supplierName || '').toLowerCase().includes(q) || r.warehouse.code.toLowerCase().includes(q);
  });

  // Every open (not yet gated out) Inbound Delivery — the queue this whole
  // page exists for. State is derived purely from the gate entry itself
  // (dockedInAt / inboundReceiptId), no dependency on Gate & Yard's own
  // yard-tracker data.
  const readyQueue = gateEntries.filter((e) => e.purpose === 'INBOUND_DELIVERY' && !e.gateOutAt);

  const openDockIn = (entry: GateEntry) => {
    setDockInFor(entry);
    setDockInForm(emptyDockInForm);
    setDockInError('');
  };
  const handleDockInSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dockInFor) return;
    setDockInError('');
    const body = {
      physicalConditionOk: dockInForm.physicalConditionOk,
      physicalConditionRemarks: dockInForm.physicalConditionRemarks || undefined,
      sealNumber: dockInForm.sealNumber || undefined,
      sealSignatureData: dockInForm.sealSignatureData || undefined,
    };
    const res = await fetch(`http://localhost:3000/gate-entries/${dockInFor.id}/dock-in`, { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) {
      setDockInError(errorText(data, 'Could not mark this vehicle docked in.'));
      return;
    }
    setDockInFor(null);
    loadGateEntries();
  };

  // Pre-fills from the assigned dock's own default staging Location
  // (2026-08-27, live-testing follow-up: "we still need to set the
  // staging area against each dock") — a plain string match between the
  // gate entry's free-text assignedDockNumber and a registered DockDoor's
  // code in the same warehouse. Purely a convenience default: still just
  // sets the same editable dropdown, no different from typing it by hand.
  const openMatchOrder = (entry: GateEntry) => {
    setMatchOrderFor(entry);
    const dock = dockDoors.find((d) => d.warehouseId === entry.warehouse.id && d.code.toUpperCase() === (entry.assignedDockNumber || '').trim().toUpperCase());
    setMatchOrderStagingLocationId(dock?.defaultStagingLocation?.id || '');
    setMatchOrderError('');
  };
  // Auto-found by vehicle (2026-08-27) — no PO/Invoice number typed at all
  // anymore, since every order now names exactly one vehicle at creation
  // (the 1:1 mapping) and the backend looks up the one unmatched order for
  // this gate entry's own vehicle. This lookup here is purely a preview so
  // staff can see what's about to be matched before confirming — the real
  // enforcement happens server-side regardless.
  const matchingReceipt = matchOrderFor ? receipts.find((r) => r.vehicle?.id === matchOrderFor.vehicle.id && !r.gateEntry) : undefined;
  const handleMatchOrderSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!matchOrderFor) return;
    setMatchOrderError('');
    const res = await fetch(`http://localhost:3000/gate-entries/${matchOrderFor.id}/match-receipt`, {
      method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ stagingLocationId: matchOrderStagingLocationId }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMatchOrderError(errorText(data, 'Could not match this order.'));
      return;
    }
    setMatchOrderFor(null);
    loadGateEntries(); load();
    openReceiving(data); // jump straight into receiving once matched
  };

  const openReceiving = (entry: GateEntry) => {
    setReceivingFor(entry);
    setCompleteInwardRemarks('');
    setCompleteInwardError('');
  };

  const handleScanSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!receivingFor || !scanInput.trim()) return;
    setScanError('');
    const res = await fetch(`http://localhost:3000/gate-entries/${receivingFor.id}/scan`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ barcode: scanInput.trim() }) });
    const data = await res.json();
    if (!res.ok) {
      setScanError(errorText(data, 'Could not record this scan.'));
      return;
    }
    setScanInput('');
    await refreshReceiving();
  };

  // No single-entry GET endpoint exists — re-fetch the full list and pick
  // this entry back out (same approach as everywhere else this codebase
  // needs a fresh single record without one).
  const refreshReceiving = async () => {
    if (!receivingFor) return;
    const list = await fetch('http://localhost:3000/gate-entries', { headers: authHeaders() }).then((r) => r.json());
    const fresh = Array.isArray(list) ? list.find((e: GateEntry) => e.id === receivingFor.id) : null;
    if (fresh) setReceivingFor(fresh);
    setGateEntries(Array.isArray(list) ? list : []);
    load();
  };

  const handleApproveScan = async (scan: InboundScan) => {
    const form = approveForms[scan.id] || { receiptLineId: scan.receiptLineId || '', quantity: scan.quantity != null ? String(scan.quantity) : '' };
    if (!form.receiptLineId || !form.quantity) { alert('Pick which SKU line this is, and a quantity, before approving.'); return; }
    const res = await fetch(`http://localhost:3000/inbound-receipts/scans/${scan.id}/approve`, {
      method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ receiptLineId: form.receiptLineId, quantity: form.quantity }),
    });
    const data = await res.json();
    if (!res.ok) { alert(errorText(data, 'Could not approve this scan.')); return; }
    await refreshReceiving();
  };
  const handleRejectScan = async (scan: InboundScan) => {
    const res = await fetch(`http://localhost:3000/inbound-receipts/scans/${scan.id}/reject`, { method: 'PATCH', headers: authHeaders() });
    if (!res.ok) { const data = await res.json(); alert(errorText(data, 'Could not reject this scan.')); return; }
    await refreshReceiving();
  };

  // "Complete Inward Process" — the deliberate close-out, enabled only once
  // the matched order is fully RECEIVED (2026-08-27). This, not receipt
  // status alone, is what Gate Out actually checks now.
  const handleCompleteInward = async () => {
    if (!receivingFor) return;
    setCompleteInwardError('');
    const res = await fetch(`http://localhost:3000/gate-entries/${receivingFor.id}/complete-inward`, {
      method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ remarks: completeInwardRemarks }),
    });
    const data = await res.json();
    if (!res.ok) {
      setCompleteInwardError(errorText(data, 'Could not complete the inward process.'));
      return;
    }
    setCompleteInwardRemarks('');
    await refreshReceiving();
  };

  // Completes an order that has no vehicle yet — today that's only ever an
  // ERP-pushed one (2026-08-27, ERP push follow-up): the manual form and
  // Excel import both still require a vehicle up front, but "ERP will
  // never know about vehicle type etc, its completely a WMS thing" (the
  // client's own framing), so this is where staff finish the order once
  // they actually know which truck it's coming on. Same
  // <input list>+<datalist> text-match pattern as the New Order form's own
  // vehicle picker.
  const handleAssignVehicleTextChange = (receiptId: string, text: string) => {
    setAssignVehicleInputs({ ...assignVehicleInputs, [receiptId]: text });
  };
  const handleAssignVehicle = async (receiptId: string) => {
    const text = assignVehicleInputs[receiptId] || '';
    const match = vehicles.find((v) => v.vehicleNumber === text);
    if (!match) {
      alert('Type or pick a registered vehicle number first.');
      return;
    }
    const res = await fetch(`http://localhost:3000/inbound-receipts/${receiptId}/assign-vehicle`, {
      method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ vehicleId: match.id }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(errorText(data, 'Could not assign this vehicle.'));
      return;
    }
    setAssignVehicleInputs({ ...assignVehicleInputs, [receiptId]: '' });
    load();
  };

  return (
    <div style={{ maxWidth: 1100, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1 style={{ textAlign: 'center' }}>Inbound Orders</h1>
      <p style={{ textAlign: 'center', color: '#666', marginTop: -8 }}>
        Create the expected SKU/quantity plan for an incoming delivery, then receive it once the vehicle's actually here.
      </p>
      {/* Always mounted (unlike the New Order form's own vehicle-options
          datalist, which only exists in the DOM while that form is open) —
          the "Assign Vehicle" action in the All Orders table below needs
          this available regardless of the form's collapsed state. */}
      <datalist id="assign-vehicle-options">
        {vehicles.map((v) => (
          <option key={v.id} value={v.vehicleNumber} />
        ))}
      </datalist>

      <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" onClick={() => (showForm ? resetForm() : setShowForm(true))}>
          {showForm ? '▾ Hide new order form' : '▸ + New Order'}
        </button>
        <a href="/templates/Inbound_Order_Import_Template.xlsx" download>Download Template</a>
        <input type="file" accept=".xlsx" onChange={(e) => setImportFile(e.target.files ? e.target.files[0] : null)} />
        <button onClick={handleImport} disabled={!importFile || importing}>
          {importing ? 'Importing...' : 'Import Orders'}
        </button>
      </div>

      {importResult && (
        <div style={{ marginBottom: 24, padding: 12, border: '1px solid #ccc', borderRadius: 8 }}>
          <p><strong>{importResult.successCount}</strong> succeeded, <strong>{importResult.failCount}</strong> failed, out of {importResult.totalOrders} order(s).</p>
          {importResult.results?.filter((r) => r.status === 'error').length > 0 && (
            <ul style={{ margin: 0 }}>
              {importResult.results.filter((r) => r.status === 'error').map((r, i) => (
                <li key={i} style={{ color: 'crimson' }}>{r.referenceNo} ({r.warehouseCode || '?'}): {r.errors.join(' | ')}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {showForm && (
        <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>New Inbound Order</h3>
          <form onSubmit={handleSubmit}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <select value={form.warehouseId} onChange={(e) => setForm({ ...form, warehouseId: e.target.value })} required style={{ width: 220 }}>
                <option value="">Warehouse *</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
                ))}
              </select>
              <input placeholder="PO / Reference No *" value={form.referenceNo} onChange={(e) => setForm({ ...form, referenceNo: e.target.value })} required style={{ width: 180 }} />
              <input placeholder="Supplier Name" value={form.supplierName} onChange={(e) => setForm({ ...form, supplierName: e.target.value })} style={{ width: 200 }} />
              <input
                list="vehicle-options"
                placeholder="Vehicle Number *"
                value={form.vehicleText}
                onChange={(e) => handleVehicleTextChange(e.target.value)}
                required
                style={{ width: 180 }}
              />
              <datalist id="vehicle-options">
                {vehicles.map((v) => (
                  <option key={v.id} value={v.vehicleNumber} />
                ))}
              </datalist>
            </div>
            <p style={{ marginTop: -8, marginBottom: 12, fontSize: 13, color: '#666' }}>
              This order will only ever match the gate entry for this exact vehicle (2026-08-27) —
              a vehicle can't have two orders open at once, so make sure it's not already on one.
              Register the vehicle from Gate & Yard first if it isn't in the list.
            </p>

            <p style={{ marginBottom: 4, fontWeight: 'bold' }}>Expected SKU / Quantity lines:</p>
            <p style={{ marginTop: 0, marginBottom: 8, fontSize: 13, color: '#666' }}>
              Staging Location is picked later, below, once the vehicle is actually at the dock (Match Order) —
              leave it blank unless this specific SKU genuinely needs to override that.
            </p>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 8 }}>
              <thead>
                <tr style={{ textAlign: 'center', borderBottom: '1px solid #ccc' }}>
                  <th style={{ padding: 6 }}>SKU</th>
                  <th style={{ padding: 6 }}>Expected Qty</th>
                  <th style={{ padding: 6 }}>Staging Location Override</th>
                  <th style={{ padding: 6 }} />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} style={{ textAlign: 'center' }}>
                    <td style={{ padding: 6 }}>
                      <input
                        list="sku-options"
                        placeholder="Type to search SKU"
                        value={l.skuText}
                        onChange={(e) => handleSkuTextChange(i, e.target.value)}
                        style={{ width: 220 }}
                      />
                    </td>
                    <td style={{ padding: 6 }}>
                      <input type="number" min="0" value={l.expectedQty} onChange={(e) => updateLine(i, { expectedQty: e.target.value })} style={{ width: 100 }} />
                    </td>
                    <td style={{ padding: 6 }}>
                      <select value={l.stagingLocationId} onChange={(e) => updateLine(i, { stagingLocationId: e.target.value })} disabled={!form.warehouseId} style={{ width: 160 }}>
                        <option value="">Select…</option>
                        {locationsForWarehouse.map((loc) => (
                          <option key={loc.id} value={loc.id}>{loc.code}</option>
                        ))}
                      </select>
                    </td>
                    <td style={{ padding: 6 }}>
                      {lines.length > 1 && (
                        <button type="button" onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}>Remove</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <datalist id="sku-options">
              {skus.map((s) => (
                <option key={s.id} value={`${s.code} — ${s.description}`} />
              ))}
            </datalist>
            <div style={{ marginBottom: 12 }}>
              <button type="button" onClick={() => setLines((ls) => [...ls, { ...emptyLine }])}>+ Add Line</button>
            </div>

            {formError && <p style={{ color: 'crimson' }}>{formError}</p>}
            <div>
              <button type="submit">Create Order</button>
              <button type="button" onClick={resetForm} style={{ marginLeft: 8 }}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {/* Dock In modal — physical condition + seal, Inbound only (2026-08-27, moved here from Gate & Yard). */}
      {dockInFor && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <h3 style={{ marginTop: 0 }}>Mark Docked In — {dockInFor.vehicle.vehicleNumber}</h3>
            <form onSubmit={handleDockInSubmit}>
              <div style={{ marginBottom: 12 }}>
                <p style={{ marginBottom: 4, fontWeight: 'bold' }}>Physical Condition (truck/trailer — dents, tyres, etc.)</p>
                <label style={{ marginRight: 16 }}>
                  <input type="radio" name="physicalConditionOk" checked={dockInForm.physicalConditionOk === true} onChange={() => setDockInForm({ ...dockInForm, physicalConditionOk: true })} /> OK
                </label>
                <label>
                  <input type="radio" name="physicalConditionOk" checked={dockInForm.physicalConditionOk === false} onChange={() => setDockInForm({ ...dockInForm, physicalConditionOk: false })} /> Flagged
                </label>
                <input
                  placeholder="Remarks (optional)"
                  value={dockInForm.physicalConditionRemarks}
                  onChange={(e) => setDockInForm({ ...dockInForm, physicalConditionRemarks: e.target.value })}
                  style={{ width: '100%', marginTop: 8, boxSizing: 'border-box' }}
                />
              </div>
              <div style={{ marginBottom: 12 }}>
                <p style={{ marginBottom: 4, fontWeight: 'bold' }}>Seal — checked as it arrived, before unloading</p>
                <input placeholder="Seal Number" value={dockInForm.sealNumber} onChange={(e) => setDockInForm({ ...dockInForm, sealNumber: e.target.value })} style={{ width: 160, marginBottom: 8, display: 'block' }} />
                <p style={{ margin: '0 0 4px', fontSize: 12, color: '#666' }}>Driver Signature</p>
                <SignaturePad value={dockInForm.sealSignatureData} onChange={(dataUrl) => setDockInForm({ ...dockInForm, sealSignatureData: dataUrl })} />
              </div>
              {dockInError && <p style={{ color: 'crimson' }}>{dockInError}</p>}
              <div>
                <button type="submit">Confirm Docked In</button>
                <button type="button" onClick={() => setDockInFor(null)} style={{ marginLeft: 8 }}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Match Order modal — auto-found by vehicle (2026-08-27), no
          PO/Invoice number typed here anymore: every order names exactly
          one vehicle at creation, so the backend just looks up the one
          unmatched order for this gate entry's own vehicle. */}
      {matchOrderFor && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <h3 style={{ marginTop: 0 }}>Match Order — {matchOrderFor.vehicle.vehicleNumber}</h3>
            {matchingReceipt ? (
              <p style={{ marginTop: -8, color: '#666' }}>
                This will match order <strong>{matchingReceipt.referenceNo}</strong> — the one order on file for this
                vehicle that hasn't been matched yet.
              </p>
            ) : (
              <p style={{ marginTop: -8, color: 'crimson' }}>
                No pending order found for this vehicle — create one on Inbound Orders first (naming this exact
                vehicle), then come back here.
              </p>
            )}
            <form onSubmit={handleMatchOrderSubmit}>
              <label style={{ display: 'block', fontSize: 13, color: '#666', marginBottom: 4 }}>Staging Location — where is this being unloaded to? *</label>
              {matchOrderStagingLocationId && (
                <p style={{ marginTop: -2, marginBottom: 4, fontSize: 12, color: '#888' }}>
                  Pre-filled from Dock {matchOrderFor.assignedDockNumber}'s default staging spot — change it if this delivery needs somewhere else.
                </p>
              )}
              <select
                value={matchOrderStagingLocationId}
                onChange={(e) => setMatchOrderStagingLocationId(e.target.value)}
                required
                style={{ width: '100%', marginBottom: 12, boxSizing: 'border-box', padding: 8 }}
              >
                <option value="">Select…</option>
                {locations.filter((l) => l.warehouseId === matchOrderFor.warehouse.id).map((l) => (
                  <option key={l.id} value={l.id}>{l.code}</option>
                ))}
              </select>
              {matchOrderError && <p style={{ color: 'crimson' }}>{matchOrderError}</p>}
              <div>
                <button type="submit" disabled={!matchingReceipt}>Match &amp; Start Receiving</button>
                <button type="button" onClick={() => setMatchOrderFor(null)} style={{ marginLeft: 8 }}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Receiving modal — scan-by-scan, capture universal / interpretation
          tiered. A hardware scanner works as-is against this plain text
          field (types the code + Enter) — a camera-scan toggle is a
          deliberate, flagged v1 gap, not built. */}
      {receivingFor && receivingFor.inboundReceipt && (
        <div style={overlayStyle}>
          <div style={{ ...modalStyle, maxWidth: 720 }}>
            <h3 style={{ marginTop: 0 }}>Receiving — {receivingFor.vehicle.vehicleNumber}</h3>
            <p style={{ marginTop: -8, color: '#666' }}>
              Order {receivingFor.inboundReceipt.referenceNo} — {STATUS_LABELS[receivingFor.inboundReceipt.status] || receivingFor.inboundReceipt.status}
              {receivingFor.inboundReceipt.stagingLocation && <> — staging at {receivingFor.inboundReceipt.stagingLocation.code}</>}
            </p>

            <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16 }}>
              <thead>
                <tr style={{ textAlign: 'center', borderBottom: '1px solid #ccc' }}>
                  <th style={{ padding: 6 }}>SKU</th>
                  <th style={{ padding: 6 }}>Expected</th>
                  <th style={{ padding: 6 }}>Received</th>
                  <th style={{ padding: 6 }}>Remaining</th>
                </tr>
              </thead>
              <tbody>
                {receivingFor.inboundReceipt.lines.map((l) => (
                  <tr key={l.id} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
                    <td style={{ padding: 6 }}>{l.sku.code} — {l.sku.description}</td>
                    <td style={{ padding: 6 }}>{l.expectedQty}</td>
                    <td style={{ padding: 6 }}>{l.receivedQty}</td>
                    <td style={{ padding: 6, fontWeight: Number(l.expectedQty) - Number(l.receivedQty) > 0 ? 'bold' : 'normal' }}>{Number(l.expectedQty) - Number(l.receivedQty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <form onSubmit={handleScanSubmit} style={{ marginBottom: 12 }}>
              <input
                autoFocus
                placeholder="Scan or type a barcode, then Enter"
                value={scanInput}
                onChange={(e) => setScanInput(e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box', padding: 8, fontSize: 16 }}
              />
              {scanError && <p style={{ color: 'crimson' }}>{scanError}</p>}
            </form>

            <p style={{ marginBottom: 4, fontWeight: 'bold' }}>Recent scans:</p>
            <div style={{ maxHeight: 260, overflowY: 'auto', marginBottom: 12 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'center', borderBottom: '1px solid #ccc' }}>
                    <th style={{ padding: 6 }}>Barcode</th>
                    <th style={{ padding: 6 }}>SKU</th>
                    <th style={{ padding: 6 }}>Qty</th>
                    <th style={{ padding: 6 }}>Status</th>
                    <th style={{ padding: 6 }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {(receivingFor.inboundScans || []).map((s) => {
                    const form = approveForms[s.id] || { receiptLineId: s.receiptLineId || '', quantity: s.quantity != null ? String(s.quantity) : '' };
                    return (
                      <tr key={s.id} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
                        <td style={{ padding: 6 }}>{s.barcodeScanned}</td>
                        <td style={{ padding: 6 }}>{s.sku ? s.sku.code : '—'}</td>
                        <td style={{ padding: 6 }}>{s.quantity ?? '—'}</td>
                        <td style={{ padding: 6, color: s.status === 'BLOCKED' ? 'crimson' : s.status === 'REJECTED' ? '#888' : 'green' }}>
                          {s.status}{s.blockReason && s.status === 'BLOCKED' ? ` — ${s.blockReason}` : ''}
                        </td>
                        <td style={{ padding: 6 }}>
                          {s.status === 'BLOCKED' && (
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'center' }}>
                              <select
                                value={form.receiptLineId}
                                onChange={(e) => setApproveForms({ ...approveForms, [s.id]: { ...form, receiptLineId: e.target.value } })}
                                style={{ width: 90 }}
                              >
                                <option value="">SKU…</option>
                                {receivingFor.inboundReceipt!.lines.map((l) => (
                                  <option key={l.id} value={l.id}>{l.sku.code}</option>
                                ))}
                              </select>
                              <input
                                placeholder="Qty"
                                value={form.quantity}
                                onChange={(e) => setApproveForms({ ...approveForms, [s.id]: { ...form, quantity: e.target.value } })}
                                style={{ width: 50 }}
                              />
                              <button type="button" onClick={() => handleApproveScan(s)}>✓</button>
                              <button type="button" onClick={() => handleRejectScan(s)}>✕</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {(receivingFor.inboundScans || []).length === 0 && (
                    <tr><td colSpan={5} style={{ padding: 12, color: '#888' }}>No scans yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* "Complete Inward Process" (2026-08-27) — the deliberate
                close-out, enabled only once every line is fully received.
                This, not receipt status alone, is what Gate Out checks. */}
            {(receivingFor.inboundReceipt.status === 'RECEIVED' || receivingFor.inboundReceipt.status === 'PUTAWAY_COMPLETE') && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #eee' }}>
                {receivingFor.inwardCompletedAt ? (
                  <p style={{ color: 'green' }}>
                    ✓ Inward process completed{receivingFor.inwardCompletedBy ? ` by ${receivingFor.inwardCompletedBy.name}` : ''} at {new Date(receivingFor.inwardCompletedAt).toLocaleString()}.
                    {receivingFor.inwardCompletionRemarks ? ` Remarks: ${receivingFor.inwardCompletionRemarks}` : ''}
                  </p>
                ) : (
                  <>
                    <p style={{ marginBottom: 4, fontWeight: 'bold' }}>Complete Inward Process</p>
                    <textarea
                      placeholder="Remarks (optional) — e.g. anything worth flagging about this delivery"
                      value={completeInwardRemarks}
                      onChange={(e) => setCompleteInwardRemarks(e.target.value)}
                      style={{ width: '100%', boxSizing: 'border-box', minHeight: 60, marginBottom: 8 }}
                    />
                    {completeInwardError && <p style={{ color: 'crimson' }}>{completeInwardError}</p>}
                    {/* Labeled "Complete Dock Out" rather than repeating the
                        section header — the client's own call, 2026-08-27:
                        the button itself should make clear to the
                        supervisor that clicking it is what lets the vehicle
                        leave the dock, not just log a remark. */}
                    <button type="button" onClick={handleCompleteInward}>Complete Dock Out</button>
                  </>
                )}
              </div>
            )}

            <div style={{ marginTop: 12 }}>
              <button type="button" onClick={() => setReceivingFor(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Vehicles ready for receiving — the working queue this page exists
          for, derived purely from open Inbound gate entries. */}
      <h2 style={{ marginBottom: 8 }}>Vehicles Ready for Receiving</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 32 }}>
        <thead>
          <tr style={{ textAlign: 'center', borderBottom: '2px solid #ccc' }}>
            <th style={{ padding: 8 }}>Vehicle</th>
            <th style={{ padding: 8 }}>Warehouse</th>
            <th style={{ padding: 8 }}>Gate In At</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8 }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {readyQueue.map((entry) => {
            let statusLabel = 'Awaiting Dock In';
            let action = <button onClick={() => openDockIn(entry)}>Mark Docked In</button>;
            if (entry.dockedInAt && !entry.inboundReceiptId) {
              statusLabel = 'Docked — awaiting order match';
              action = <button onClick={() => openMatchOrder(entry)}>Match Order</button>;
            } else if (entry.inboundReceiptId) {
              statusLabel = entry.inwardCompletedAt
                ? `Order ${entry.inboundReceipt?.referenceNo || ''} — Inward Completed ✓`
                : `Order ${entry.inboundReceipt?.referenceNo || ''} — ${STATUS_LABELS[entry.inboundReceipt?.status || ''] || entry.inboundReceipt?.status || ''}`;
              action = <button onClick={() => openReceiving(entry)}>{entry.inwardCompletedAt ? 'View' : 'Receive'}</button>;
            }
            return (
              <tr key={entry.id} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
                <td style={{ padding: 8, fontWeight: 'bold' }}>{entry.vehicle.vehicleNumber}</td>
                <td style={{ padding: 8 }}>{entry.warehouse.code}</td>
                <td style={{ padding: 8 }}>{new Date(entry.gateInAt).toLocaleString()}</td>
                <td style={{ padding: 8 }}>{statusLabel}</td>
                <td style={{ padding: 8 }}>{action}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {readyQueue.length === 0 && <p style={{ marginTop: -16, marginBottom: 32 }}>No Inbound vehicles currently open.</p>}

      <h2 style={{ marginBottom: 8 }}>All Orders</h2>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center' }}>
        <input placeholder="Search reference no, supplier, warehouse..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 320, padding: 8 }} />
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'center', borderBottom: '2px solid #ccc' }}>
            <th style={{ padding: 8 }}>Reference No</th>
            <th style={{ padding: 8 }}>Warehouse</th>
            <th style={{ padding: 8 }}>Supplier</th>
            <th style={{ padding: 8 }}>Lines</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8 }}>Vehicle</th>
            <th style={{ padding: 8 }}>Created</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((r) => {
            const totalExpected = r.lines.reduce((s, l) => s + Number(l.expectedQty), 0);
            const totalReceived = r.lines.reduce((s, l) => s + Number(l.receivedQty), 0);
            return (
              <tr key={r.id} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
                <td style={{ padding: 8, fontWeight: 'bold' }}>{r.referenceNo}</td>
                <td style={{ padding: 8 }}>{r.warehouse.code}</td>
                <td style={{ padding: 8 }}>{r.supplierName || '—'}</td>
                <td style={{ padding: 8 }}>{r.lines.length} SKU{r.lines.length !== 1 ? 's' : ''} ({totalReceived}/{totalExpected})</td>
                <td style={{ padding: 8 }}>{STATUS_LABELS[r.status] || r.status}</td>
                <td style={{ padding: 8 }}>
                  {r.vehicle?.vehicleNumber || r.gateEntry?.vehicle.vehicleNumber || (
                    <div style={{ display: 'flex', gap: 4, justifyContent: 'center', alignItems: 'center' }}>
                      <input
                        list="assign-vehicle-options"
                        placeholder="Vehicle #"
                        value={assignVehicleInputs[r.id] || ''}
                        onChange={(e) => handleAssignVehicleTextChange(r.id, e.target.value)}
                        style={{ width: 100 }}
                      />
                      <button onClick={() => handleAssignVehicle(r.id)}>Assign</button>
                    </div>
                  )}
                </td>
                <td style={{ padding: 8 }}>
                  {new Date(r.createdAt).toLocaleDateString()}
                  {r.createdViaErpPush && <div style={{ fontSize: 11, color: '#888' }}>via ERP</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {filtered.length === 0 && <p style={{ textAlign: 'center' }}>No inbound orders found.</p>}
    </div>
  );
}

export default InboundOrdersPage;

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
};
const modalStyle: React.CSSProperties = {
  background: '#fff', padding: 24, borderRadius: 8, maxWidth: 560, width: '90%', maxHeight: '90vh', overflowY: 'auto',
};

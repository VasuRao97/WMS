import { useEffect, useState } from 'react';

// Outbound Orders — the "order maker" half of Outbound/Picking (2026-09-14,
// see CLAUDE.md's Outbound/Picking/Dispatch design section for the full
// round-by-round conversation). Orders are uploaded VEHICLE-WISE, but the
// vehicle itself is resolved AFTER creation, not required up front — the
// opposite of Inbound's own pattern — by matching an already-gated-in
// vehicle whose destination city agrees, then a Supervisor+ explicitly
// allots one candidate to the order (even with exactly one candidate,
// matching this codebase's own "a match is a deliberate click" rule).
// Manual creation only this pass — Excel import and ERP push are confirmed
// wanted but not built yet, flagged rather than silently dropped.

type Warehouse = { id: string; code: string; name: string };
type Sku = { id: string; code: string; description: string };
type OrderLine = {
  id: string;
  sku: Sku;
  orderedQty: number;
  pickedQty: number;
  isPriority: boolean;
};
type Order = {
  id: string;
  orderNo: string;
  destinationCity: string;
  customerName?: string;
  status: 'CREATED' | 'ALLOTTED' | 'ALLOCATED' | 'PICKING' | 'PICKED' | 'PACKED' | 'DISPATCHED' | 'CANCELLED';
  warehouse: Warehouse;
  vehicle?: { id: string; vehicleNumber: string } | null;
  gateEntry?: { id: string; assignedDockNumber?: string; dockedInAt?: string; gateOutAt?: string } | null;
  lines: OrderLine[];
  createdBy?: { name: string } | null;
  createdAt: string;
};
type CandidateVehicle = {
  id: string;
  destinationCity: string;
  gateInAt: string;
  vehicle: { id: string; vehicleNumber: string };
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
  CREATED: 'Created',
  ALLOTTED: 'Allotted',
  ALLOCATED: 'Allocated',
  PICKING: 'Picking',
  PICKED: 'Picked',
  PACKED: 'Packed',
  DISPATCHED: 'Dispatched',
  CANCELLED: 'Cancelled',
};

const emptyLine = { skuId: '', skuText: '', orderedQty: '', isPriority: false };
const emptyForm = { warehouseId: '', orderNo: '', destinationCity: '', customerName: '' };

function OutboundOrdersPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [skus, setSkus] = useState<Sku[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [filterWarehouseId, setFilterWarehouseId] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [lines, setLines] = useState([{ ...emptyLine }]);
  const [formError, setFormError] = useState('');

  const [allotFor, setAllotFor] = useState<Order | null>(null);
  const [candidates, setCandidates] = useState<CandidateVehicle[]>([]);
  const [selectedGateEntryId, setSelectedGateEntryId] = useState('');
  const [allotError, setAllotError] = useState('');
  const [allotBusy, setAllotBusy] = useState(false);

  const loadOrders = () => {
    const qs = filterWarehouseId ? `?warehouseId=${filterWarehouseId}` : '';
    fetch(`http://localhost:3000/outbound-orders${qs}`, { headers: authHeaders() })
      .then((r) => (r.status === 401 ? [] : r.json()))
      .then((d) => setOrders(Array.isArray(d) ? d : []));
  };

  useEffect(() => {
    fetch('http://localhost:3000/warehouses', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setWarehouses(Array.isArray(d) ? d : []));
    fetch('http://localhost:3000/skus', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setSkus(Array.isArray(d) ? d : []));
  }, []);
  useEffect(() => { loadOrders(); }, [filterWarehouseId]);

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
    const match = skus.find((s) => `${s.code} — ${s.description}` === text || s.code === text);
    updateLine(i, { skuText: text, skuId: match ? match.id : '' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    const badLine = lines.find((l) => !l.skuId || !l.orderedQty || Number(l.orderedQty) <= 0);
    if (badLine) {
      setFormError('Every line needs a real SKU (pick one from the list) and a positive Quantity.');
      return;
    }
    const res = await fetch('http://localhost:3000/outbound-orders', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        warehouseId: form.warehouseId,
        orderNo: form.orderNo,
        destinationCity: form.destinationCity,
        customerName: form.customerName || undefined,
        lines: lines.map((l) => ({ skuId: l.skuId, orderedQty: Number(l.orderedQty), isPriority: l.isPriority })),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setFormError(errorText(data, 'Could not create this order.'));
      return;
    }
    resetForm();
    loadOrders();
  };

  const openAllot = async (order: Order) => {
    setAllotFor(order);
    setCandidates([]);
    setSelectedGateEntryId('');
    setAllotError('');
    const res = await fetch(`http://localhost:3000/outbound-orders/${order.id}/candidate-vehicles`, { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) {
      setAllotError(errorText(data, 'Could not load candidate vehicles.'));
      return;
    }
    setCandidates(Array.isArray(data) ? data : []);
  };

  const handleAllot = async () => {
    if (!allotFor || !selectedGateEntryId) return;
    setAllotBusy(true);
    setAllotError('');
    const res = await fetch(`http://localhost:3000/outbound-orders/${allotFor.id}/allot`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ gateEntryId: selectedGateEntryId }),
    });
    const data = await res.json();
    setAllotBusy(false);
    if (!res.ok) {
      setAllotError(errorText(data, 'Could not allot this vehicle.'));
      return;
    }
    setAllotFor(null);
    loadOrders();
  };

  return (
    <div style={{ maxWidth: 1100, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1 style={{ textAlign: 'center' }}>Outbound Orders</h1>
      <p style={{ textAlign: 'center', color: '#666', marginTop: -8 }}>
        Upload an order (destination city + SKU/qty/priority lines), then once a matching vehicle has gated in,
        allot it — that's the moment real pick tasks get reserved against on-hand stock.
      </p>

      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center', gap: 8 }}>
        <select value={filterWarehouseId} onChange={(e) => setFilterWarehouseId(e.target.value)} style={{ width: 200, padding: 6 }}>
          <option value="">All warehouses</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>{w.code}</option>
          ))}
        </select>
        <button type="button" onClick={() => (showForm ? resetForm() : setShowForm(true))}>
          {showForm ? '▾ Hide new order form' : '▸ + New Order'}
        </button>
      </div>

      {showForm && (
        <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>New Outbound Order</h3>
          <form onSubmit={handleSubmit}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <select value={form.warehouseId} onChange={(e) => setForm({ ...form, warehouseId: e.target.value })} required style={{ width: 220 }}>
                <option value="">Warehouse *</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
                ))}
              </select>
              <input placeholder="Order No *" value={form.orderNo} onChange={(e) => setForm({ ...form, orderNo: e.target.value })} required style={{ width: 160 }} />
              <input placeholder="Destination City *" value={form.destinationCity} onChange={(e) => setForm({ ...form, destinationCity: e.target.value })} required style={{ width: 180 }} />
              <input placeholder="Customer Name" value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} style={{ width: 200 }} />
            </div>

            <p style={{ marginBottom: 4, fontWeight: 'bold' }}>SKU / Quantity lines:</p>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 8 }}>
              <thead>
                <tr style={{ textAlign: 'center', borderBottom: '1px solid #ccc' }}>
                  <th style={{ padding: 6 }}>SKU</th>
                  <th style={{ padding: 6 }}>Ordered Qty</th>
                  <th style={{ padding: 6 }}>Priority</th>
                  <th style={{ padding: 6 }} />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} style={{ textAlign: 'center' }}>
                    <td style={{ padding: 6 }}>
                      <input
                        list="ob-sku-options"
                        placeholder="Type to search SKU"
                        value={l.skuText}
                        onChange={(e) => handleSkuTextChange(i, e.target.value)}
                        style={{ width: 220 }}
                      />
                    </td>
                    <td style={{ padding: 6 }}>
                      <input type="number" min="0" value={l.orderedQty} onChange={(e) => updateLine(i, { orderedQty: e.target.value })} style={{ width: 100 }} />
                    </td>
                    <td style={{ padding: 6 }}>
                      <input type="checkbox" checked={l.isPriority} onChange={(e) => updateLine(i, { isPriority: e.target.checked })} title="Must be loaded before dispatch — a completion gate, not a pick-sequencing hint." />
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
            <datalist id="ob-sku-options">
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

      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 32 }}>
        <thead>
          <tr style={{ textAlign: 'center', borderBottom: '2px solid #ccc' }}>
            <th style={{ padding: 8 }}>Order No</th>
            <th style={{ padding: 8 }}>Warehouse</th>
            <th style={{ padding: 8 }}>Destination</th>
            <th style={{ padding: 8 }}>Customer</th>
            <th style={{ padding: 8 }}>Lines</th>
            <th style={{ padding: 8 }}>Vehicle</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
              <td style={{ padding: 8 }}>{o.orderNo}</td>
              <td style={{ padding: 8 }}>{o.warehouse.code}</td>
              <td style={{ padding: 8 }}>{o.destinationCity}</td>
              <td style={{ padding: 8 }}>{o.customerName || '—'}</td>
              <td style={{ padding: 8 }}>
                {o.lines.map((l) => (
                  <div key={l.id}>
                    {l.sku.code} — {Number(l.pickedQty)}/{Number(l.orderedQty)}{l.isPriority ? ' ⭑' : ''}
                  </div>
                ))}
              </td>
              <td style={{ padding: 8 }}>{o.vehicle?.vehicleNumber || '—'}</td>
              <td style={{ padding: 8 }}>{STATUS_LABELS[o.status]}</td>
              <td style={{ padding: 8 }}>
                {o.status === 'CREATED' && (
                  <button onClick={() => openAllot(o)}>Allot Vehicle</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {orders.length === 0 && <p style={{ textAlign: 'center' }}>No outbound orders found.</p>}

      {allotFor && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', padding: 24, borderRadius: 8, width: 500, maxHeight: '80vh', overflowY: 'auto' }}>
            <h3 style={{ marginTop: 0 }}>Allot Vehicle — {allotFor.orderNo}</h3>
            <p style={{ fontSize: 13, color: '#666' }}>
              Gated-in vehicles whose destination matches "{allotFor.destinationCity}" and aren't already allotted.
            </p>
            {candidates.length === 0 ? (
              <p>No candidate vehicles right now — the vehicle needs to gate in first.</p>
            ) : (
              candidates.map((c) => (
                <label key={c.id} style={{ display: 'block', padding: 8, border: '1px solid #eee', borderRadius: 6, marginBottom: 6, cursor: 'pointer' }}>
                  <input type="radio" name="gateEntry" checked={selectedGateEntryId === c.id} onChange={() => setSelectedGateEntryId(c.id)} style={{ marginRight: 8 }} />
                  {c.vehicle.vehicleNumber} — gated in {new Date(c.gateInAt).toLocaleString()}
                </label>
              ))
            )}
            {allotError && <p style={{ color: 'crimson' }}>{allotError}</p>}
            <div style={{ marginTop: 12 }}>
              <button onClick={handleAllot} disabled={!selectedGateEntryId || allotBusy}>
                {allotBusy ? 'Allotting...' : 'Allot'}
              </button>
              <button type="button" onClick={() => setAllotFor(null)} style={{ marginLeft: 8 }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default OutboundOrdersPage;

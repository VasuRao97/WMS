import { useEffect, useState } from 'react';

// Putaway — standalone task queue + scan-driven execution (2026-08-28,
// skeleton logic just built — see [[wms-putaway-design]] in memory for the
// full design conversation). The real workflow: scan the case/pallet at
// staging (claims one trip), the system tells you the destination, scan
// the destination location to confirm — only a matching scan completes it,
// no manual override. Also carries the Multi-SKU Lane Exception request/
// approve/revoke workflow (Warehouse Manager requests, Company Admin
// decides) — the only bypass for the mandatory single-SKU-per-multi-deep-
// lane rule.

type Warehouse = { id: string; code: string; name: string };
type PutawayTask = {
  id: string;
  sku: { id: string; code: string; description: string };
  fromLocation: { id: string; code: string };
  toLocation?: { id: string; code: string } | null;
  quantity: number;
  movedQuantity: number;
  status: 'NEEDS_BIN' | 'PENDING' | 'COMPLETED';
  inProgressTrip?: { id: string; quantity: number } | null;
};
type Trip = { id: string; quantity: number; task: PutawayTask };
type Exception = {
  id: string;
  warehouse: Warehouse;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'REVOKED';
  requestedBy: { name: string };
  requestedAt: string;
  reviewedBy?: { name: string } | null;
  reviewNote?: string | null;
};

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('token')}` };
}
function jsonHeaders() {
  return { 'Content-Type': 'application/json', ...authHeaders() };
}
function currentUser(): any {
  return localStorage.getItem('user') ? JSON.parse(localStorage.getItem('user')!) : null;
}
function errorText(data: any, fallback: string) {
  return Array.isArray(data?.message) ? data.message.join(' | ') : data?.message || fallback;
}

const STATUS_LABELS: Record<string, string> = { NEEDS_BIN: 'Needs Bin', PENDING: 'Pending', COMPLETED: 'Completed' };

function PutawayPage() {
  const user = currentUser();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [filterWarehouseId, setFilterWarehouseId] = useState('');
  const [tasks, setTasks] = useState<PutawayTask[]>([]);

  const [barcode, setBarcode] = useState('');
  const [activeTrip, setActiveTrip] = useState<Trip | null>(null);
  const [locationCode, setLocationCode] = useState('');
  const [scanError, setScanError] = useState('');
  const [scanMsg, setScanMsg] = useState('');

  const [reassignReason, setReassignReason] = useState<Record<string, string>>({});
  const [taskMsg, setTaskMsg] = useState('');

  const [exceptions, setExceptions] = useState<Exception[]>([]);
  const [exceptionWarehouseId, setExceptionWarehouseId] = useState('');
  const [exceptionReason, setExceptionReason] = useState('');
  const [exceptionMsg, setExceptionMsg] = useState('');

  const loadTasks = () => {
    const qs = filterWarehouseId ? `?warehouseId=${filterWarehouseId}` : '';
    fetch(`http://localhost:3000/putaway-tasks${qs}`, { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setTasks(Array.isArray(d) ? d : []));
  };
  const loadExceptions = () => {
    fetch('http://localhost:3000/multi-sku-lane-exceptions', { headers: authHeaders() }).then((r) => (r.status === 401 || r.status === 403 ? [] : r.json())).then((d) => setExceptions(Array.isArray(d) ? d : []));
  };
  useEffect(() => {
    fetch('http://localhost:3000/warehouses', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setWarehouses(Array.isArray(d) ? d : []));
    loadExceptions();
  }, []);
  useEffect(() => { loadTasks(); }, [filterWarehouseId]);

  const canRequestException = user?.role === 'WAREHOUSE_MANAGER';
  const canDecideException = user?.role === 'COMPANY_ADMIN';

  const handleClaim = async () => {
    setScanError('');
    setScanMsg('');
    if (!barcode.trim()) return;
    const res = await fetch('http://localhost:3000/putaway-tasks/claim', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ barcode }) });
    const data = await res.json();
    if (!res.ok) {
      setScanError(errorText(data, 'Could not claim a trip for this barcode.'));
      return;
    }
    setActiveTrip(data);
    setBarcode('');
  };

  const handleCompleteTrip = async () => {
    if (!activeTrip) return;
    setScanError('');
    const res = await fetch(`http://localhost:3000/putaway-tasks/trips/${activeTrip.id}/complete`, { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ locationCode }) });
    const data = await res.json();
    if (!res.ok) {
      setScanError(errorText(data, 'Could not complete this trip.'));
      return;
    }
    setScanMsg(`Trip completed — ${activeTrip.task.sku.code} put away at ${locationCode.toUpperCase()}.`);
    setActiveTrip(null);
    setLocationCode('');
    loadTasks();
  };

  const handleRequestDifferentBin = async (taskId: string) => {
    setTaskMsg('');
    const res = await fetch(`http://localhost:3000/putaway-tasks/${taskId}/request-different-bin`, { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ reason: reassignReason[taskId] || '' }) });
    const data = await res.json();
    if (!res.ok) {
      setTaskMsg(errorText(data, 'Could not reassign this task.'));
      return;
    }
    setTaskMsg(data.toLocationId ? `Reassigned to ${data.toLocation?.code}.` : 'No alternative bin found — still Needs Bin.');
    loadTasks();
  };

  const handleRequestException = async (e: React.FormEvent) => {
    e.preventDefault();
    setExceptionMsg('');
    const res = await fetch('http://localhost:3000/multi-sku-lane-exceptions', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ warehouseId: exceptionWarehouseId, reason: exceptionReason }) });
    const data = await res.json();
    if (!res.ok) {
      setExceptionMsg(errorText(data, 'Could not submit this request.'));
      return;
    }
    setExceptionMsg('Request submitted — awaiting Company Admin approval.');
    setExceptionReason('');
    loadExceptions();
  };

  const handleDecideException = async (id: string, action: 'approve' | 'reject' | 'revoke') => {
    const res = await fetch(`http://localhost:3000/multi-sku-lane-exceptions/${id}/${action}`, { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({}) });
    const data = await res.json();
    if (!res.ok) {
      setExceptionMsg(errorText(data, `Could not ${action} this request.`));
      return;
    }
    loadExceptions();
  };

  return (
    <div style={{ maxWidth: 1100, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1 style={{ textAlign: 'center' }}>Putaway</h1>
      <p style={{ textAlign: 'center', color: '#666', marginTop: -8 }}>
        Scan the case/pallet at staging, then scan the destination the system tells you — only a matching
        scan completes the putaway. The bin is always system-suggested; it's never a manual pick.
      </p>

      <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>Scan Putaway</h3>
        {!activeTrip ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              placeholder="Scan case/pallet barcode..." value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleClaim()}
              style={{ width: 260, padding: 8 }} autoFocus
            />
            <button onClick={handleClaim}>Claim</button>
          </div>
        ) : (
          <div>
            <p>
              <strong>{activeTrip.task.sku.code}</strong> — {activeTrip.task.sku.description} — take{' '}
              <strong>{Number(activeTrip.quantity)}</strong> from <strong>{activeTrip.task.fromLocation.code}</strong> to{' '}
              <strong>{activeTrip.task.toLocation?.code}</strong>
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                placeholder="Scan destination location..." value={locationCode}
                onChange={(e) => setLocationCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCompleteTrip()}
                style={{ width: 260, padding: 8 }} autoFocus
              />
              <button onClick={handleCompleteTrip}>Complete</button>
              <button type="button" onClick={() => { setActiveTrip(null); setLocationCode(''); }}>Cancel</button>
            </div>
          </div>
        )}
        {scanError && <p style={{ color: 'crimson' }}>{scanError}</p>}
        {scanMsg && <p style={{ color: 'green' }}>{scanMsg}</p>}
      </div>

      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center' }}>
        <select value={filterWarehouseId} onChange={(e) => setFilterWarehouseId(e.target.value)} style={{ width: 200, padding: 6 }}>
          <option value="">All warehouses</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>{w.code}</option>
          ))}
        </select>
      </div>
      {taskMsg && <p style={{ textAlign: 'center' }}>{taskMsg}</p>}

      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 32 }}>
        <thead>
          <tr style={{ textAlign: 'center', borderBottom: '2px solid #ccc' }}>
            <th style={{ padding: 8 }}>SKU</th>
            <th style={{ padding: 8 }}>From</th>
            <th style={{ padding: 8 }}>To</th>
            <th style={{ padding: 8 }}>Qty</th>
            <th style={{ padding: 8 }}>Moved</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
              <td style={{ padding: 8 }}>{t.sku.code}</td>
              <td style={{ padding: 8 }}>{t.fromLocation.code}</td>
              <td style={{ padding: 8 }}>{t.toLocation?.code || <span style={{ color: 'crimson' }}>Needs Bin</span>}</td>
              <td style={{ padding: 8 }}>{Number(t.quantity)}</td>
              <td style={{ padding: 8 }}>{Number(t.movedQuantity)}</td>
              <td style={{ padding: 8 }}>{STATUS_LABELS[t.status]}</td>
              <td style={{ padding: 8, whiteSpace: 'nowrap' }}>
                {t.status !== 'COMPLETED' && !t.inProgressTrip && (
                  <>
                    <input
                      placeholder="Reason" value={reassignReason[t.id] || ''}
                      onChange={(e) => setReassignReason({ ...reassignReason, [t.id]: e.target.value })}
                      style={{ width: 100, marginRight: 4 }}
                    />
                    <button onClick={() => handleRequestDifferentBin(t.id)}>Request Different Bin</button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {tasks.length === 0 && <p style={{ textAlign: 'center' }}>No putaway tasks found.</p>}

      {(canRequestException || canDecideException || exceptions.length > 0) && (
        <div style={{ marginTop: 32, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>Multi-SKU Lane Exception</h3>
          <p style={{ fontSize: 13, color: '#666', marginTop: -8 }}>
            The only way to allow more than one SKU sharing a multi-deep lane — requested by a Warehouse
            Manager, decided only by a Company Admin, visible to both sides.
          </p>

          {canRequestException && (
            <form onSubmit={handleRequestException} style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select value={exceptionWarehouseId} onChange={(e) => setExceptionWarehouseId(e.target.value)} required style={{ width: 160 }}>
                <option value="">Warehouse *</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>{w.code}</option>
                ))}
              </select>
              <input placeholder="Reason *" value={exceptionReason} onChange={(e) => setExceptionReason(e.target.value)} required style={{ width: 260 }} />
              <button type="submit">Request Exception</button>
            </form>
          )}
          {exceptionMsg && <p>{exceptionMsg}</p>}

          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'center', borderBottom: '2px solid #ccc' }}>
                <th style={{ padding: 8 }}>Warehouse</th>
                <th style={{ padding: 8 }}>Reason</th>
                <th style={{ padding: 8 }}>Requested By</th>
                <th style={{ padding: 8 }}>Status</th>
                <th style={{ padding: 8 }}>Reviewed By</th>
                {canDecideException && <th style={{ padding: 8 }}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {exceptions.map((ex) => (
                <tr key={ex.id} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: 8 }}>{ex.warehouse.code}</td>
                  <td style={{ padding: 8 }}>{ex.reason}</td>
                  <td style={{ padding: 8 }}>{ex.requestedBy.name}</td>
                  <td style={{ padding: 8 }}>{ex.status}</td>
                  <td style={{ padding: 8 }}>{ex.reviewedBy?.name || '—'}</td>
                  {canDecideException && (
                    <td style={{ padding: 8, whiteSpace: 'nowrap' }}>
                      {ex.status === 'PENDING' && (
                        <>
                          <button onClick={() => handleDecideException(ex.id, 'approve')}>Approve</button>
                          <button onClick={() => handleDecideException(ex.id, 'reject')} style={{ marginLeft: 6 }}>Reject</button>
                        </>
                      )}
                      {ex.status === 'APPROVED' && (
                        <button onClick={() => handleDecideException(ex.id, 'revoke')} style={{ color: 'crimson' }}>Revoke</button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {exceptions.length === 0 && <p style={{ textAlign: 'center' }}>No exception requests.</p>}
        </div>
      )}
    </div>
  );
}

export default PutawayPage;

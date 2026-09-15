import { useEffect, useState } from 'react';

// Picking — task queue + scan-driven execution (2026-09-14, see CLAUDE.md's
// Outbound/Picking/Dispatch design section for the full conversation).
// Unlike Putaway, claiming needs no barcode scan (nothing physical is in
// hand yet) — a plain "Claim Next Task" button always grabs the oldest
// workable task, FIFO, regardless of which operator clicks it. Completion
// is two-tier: a whole-unit match needs only a location + pallet scan
// (cross-checked against the ledger), a partial/broken pick needs a
// location scan plus one barcode scan per individual unit.

type Warehouse = { id: string; code: string; name: string };
type LocationRef = { id: string; code: string; storageType?: string; rack?: string | null; level?: string | null; depth?: number | null; flankNumber?: number | null };
type PickTask = {
  id: string;
  sku: { id: string; code: string; description: string };
  fromLocation?: LocationRef | null;
  toLocation?: LocationRef | null;
  quantity: number;
  movedQuantity: number;
  status: 'NEEDS_SOURCE' | 'PENDING' | 'COMPLETED';
  inProgressTrip?: boolean;
  orderLine?: {
    isPriority: boolean;
    order: { orderNo: string; destinationCity: string };
  };
};
type Trip = { id: string; quantity: number; task: PickTask };

// Operator assignment fairness (2026-09-14 gap-fix pass, item 3) — mirrors
// PutawayPage.tsx's own Recommendation type/banner exactly, just against
// /pick-tasks/recommendation.
type Recommendation = {
  priorityTask: { skuCode: string; locationCode: string; waitingSince: string } | null;
  recommendedOperator: { id: string; name: string; freeSince: string } | null;
};

// Mid-pick exceptions (item 4) — SHORT_STOCK/SHORT_QUANTITY are auto-logged
// (reportedByName null, shown as "System"); EMPTY_BIN/WRONG_SKU/DAMAGED/
// OTHER come from an operator's own explicit report.
type PickException = {
  id: string;
  reason: 'SHORT_STOCK' | 'EMPTY_BIN' | 'WRONG_SKU' | 'SHORT_QUANTITY' | 'DAMAGED' | 'OTHER';
  notes: string | null;
  skuCode: string;
  orderNo: string;
  reportedByName: string | null;
  reportedAt: string;
  reviewedAt: string | null;
  reviewedByName: string | null;
};

// Shape of the `user` object /auth/login and /auth/register store into
// localStorage — not the full User row. Same shape PutawayPage.tsx reads.
interface CurrentUser {
  id: string;
  email: string;
  role: string;
  companyId: string | null;
}
function currentUser(): CurrentUser | null {
  return localStorage.getItem('user') ? JSON.parse(localStorage.getItem('user')!) : null;
}

// Rack storage types (mirrors backend RACK_STORAGE_TYPES, ASRS removed
// 2026-09-13) — only these get a Rack Name; Ground/Stillage fall back to
// the raw code. Same formula as PutawayPage.tsx's own displayCode().
const RACK_STORAGE_TYPES = ['SPR', 'DRIVE_IN'];
function displayCode(loc?: LocationRef | null): string {
  if (!loc) return '—';
  if (loc.storageType && RACK_STORAGE_TYPES.includes(loc.storageType) && loc.flankNumber != null && loc.rack && loc.level) {
    const parts = [`R${loc.flankNumber}`, loc.rack, `L${loc.level}`];
    if (loc.depth != null) parts.push(`D${loc.depth}`);
    return parts.join('-');
  }
  return loc.code;
}

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('token')}` };
}
function jsonHeaders() {
  return { 'Content-Type': 'application/json', ...authHeaders() };
}
function errorText(data: any, fallback: string) {
  return Array.isArray(data?.message) ? data.message.join(' | ') : data?.message || fallback;
}

const STATUS_LABELS: Record<string, string> = { NEEDS_SOURCE: 'Needs Source', PENDING: 'Pending', COMPLETED: 'Completed' };

function PickTasksPage() {
  const user = currentUser();
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [filterWarehouseId, setFilterWarehouseId] = useState('');
  const [tasks, setTasks] = useState<PickTask[]>([]);

  const [activeTrip, setActiveTrip] = useState<Trip | null>(null);
  const [claimError, setClaimError] = useState('');
  const [claimBusy, setClaimBusy] = useState(false);

  const [locationCode, setLocationCode] = useState('');
  const [pickMode, setPickMode] = useState<'pallet' | 'unit'>('pallet');
  const [palletCode, setPalletCode] = useState('');
  const [unitBarcode, setUnitBarcode] = useState('');
  const [unitBarcodes, setUnitBarcodes] = useState<string[]>([]);
  const [completeError, setCompleteError] = useState('');
  const [completeMsg, setCompleteMsg] = useState('');

  // Mid-pick "Report a Problem" (item 4) — a toggle on the active-trip
  // form, revealing a reason dropdown + optional notes + its own submit
  // button, separate from the location/pallet/unit completion fields above.
  const [showReportProblem, setShowReportProblem] = useState(false);
  const [problemReason, setProblemReason] = useState('EMPTY_BIN');
  const [problemNotes, setProblemNotes] = useState('');
  const [problemError, setProblemError] = useState('');

  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);

  const [taskMsg, setTaskMsg] = useState('');

  const [exceptions, setExceptions] = useState<PickException[]>([]);
  const [exceptionMsg, setExceptionMsg] = useState('');

  const canReviewExceptions = ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR'].includes(user?.role ?? '');

  const loadTasks = () => {
    const qs = filterWarehouseId ? `?warehouseId=${filterWarehouseId}` : '';
    fetch(`http://localhost:3000/pick-tasks${qs}`, { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setTasks(Array.isArray(d) ? d : []));
  };
  // No warehouseId required — auto-scoped server-side to whatever the
  // caller can actually access, same convention as Putaway's own
  // recommendation, since an Operator has no warehouse picker to begin with.
  const loadRecommendation = () => {
    const qs = filterWarehouseId ? `?warehouseId=${filterWarehouseId}` : '';
    fetch(`http://localhost:3000/pick-tasks/recommendation${qs}`, { headers: authHeaders() })
      .then((r) => (r.status === 401 ? null : r.json()))
      .then((d) => setRecommendation(d || null));
  };
  // Supervisor+ only — an Operator never sees this fetch attempted at all,
  // matching the backend's own PICK_EXCEPTION_REVIEW_ROLES gate.
  const loadExceptions = () => {
    if (!canReviewExceptions) return;
    const qs = filterWarehouseId ? `?warehouseId=${filterWarehouseId}` : '';
    fetch(`http://localhost:3000/pick-tasks/exceptions${qs}`, { headers: authHeaders() })
      .then((r) => (r.status === 401 || r.status === 403 ? [] : r.json()))
      .then((d) => setExceptions(Array.isArray(d) ? d : []));
  };

  useEffect(() => {
    fetch('http://localhost:3000/warehouses', { headers: authHeaders() }).then((r) => (r.status === 401 ? [] : r.json())).then((d) => setWarehouses(Array.isArray(d) ? d : []));
  }, []);
  useEffect(() => { loadTasks(); loadRecommendation(); loadExceptions(); }, [filterWarehouseId]);

  const handleClaim = async () => {
    setClaimError('');
    setClaimBusy(true);
    const res = await fetch('http://localhost:3000/pick-tasks/claim', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ warehouseId: filterWarehouseId || undefined }),
    });
    const data = await res.json();
    setClaimBusy(false);
    if (!res.ok) {
      setClaimError(errorText(data, 'No workable picking task right now.'));
      return;
    }
    setActiveTrip(data);
    loadTasks();
    loadRecommendation();
  };

  const resetCompleteForm = () => {
    setLocationCode('');
    setPalletCode('');
    setUnitBarcode('');
    setUnitBarcodes([]);
    setCompleteError('');
    setShowReportProblem(false);
    setProblemReason('EMPTY_BIN');
    setProblemNotes('');
    setProblemError('');
  };

  const addUnitBarcode = () => {
    const v = unitBarcode.trim();
    if (!v) return;
    setUnitBarcodes((bs) => [...bs, v]);
    setUnitBarcode('');
  };

  const handleCompleteTrip = async () => {
    if (!activeTrip) return;
    setCompleteError('');
    const body: any = { locationCode };
    if (pickMode === 'pallet') body.palletCode = palletCode;
    else body.unitBarcodes = unitBarcodes;
    const res = await fetch(`http://localhost:3000/pick-tasks/trips/${activeTrip.id}/complete`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      setCompleteError(errorText(data, 'Could not complete this trip.'));
      return;
    }
    setCompleteMsg(`Trip completed — ${activeTrip.task.sku.code} picked from ${locationCode.toUpperCase()}.`);
    setActiveTrip(null);
    resetCompleteForm();
    loadTasks();
    loadRecommendation();
  };

  // Explicit mid-pick exception report (item 4) — abandons the active trip
  // and hands the task back for source recovery, no location/pallet/unit
  // scan needed since nothing was actually picked.
  const handleReportProblem = async () => {
    if (!activeTrip) return;
    setProblemError('');
    const res = await fetch(`http://localhost:3000/pick-tasks/trips/${activeTrip.id}/exception`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ reason: problemReason, notes: problemNotes || undefined }),
    });
    const data = await res.json();
    if (!res.ok) {
      setProblemError(errorText(data, 'Could not report this problem.'));
      return;
    }
    setCompleteMsg(`Reported ${problemReason.replace('_', ' ').toLowerCase()} — ${activeTrip.task.sku.code} sent back for a new source.`);
    setActiveTrip(null);
    resetCompleteForm();
    loadTasks();
    loadRecommendation();
    loadExceptions();
  };

  // Short-stock retry (item 1) — a "Retry Source" button on any
  // NEEDS_SOURCE row in the task table.
  const handleRetrySource = async (taskId: string) => {
    setTaskMsg('');
    const res = await fetch(`http://localhost:3000/pick-tasks/${taskId}/retry-source`, {
      method: 'POST',
      headers: jsonHeaders(),
    });
    const data = await res.json();
    if (!res.ok) {
      setTaskMsg(errorText(data, 'Could not retry this task.'));
      return;
    }
    setTaskMsg(
      data.status === 'NEEDS_SOURCE'
        ? 'No source found yet — still Needs Source.'
        : `Source found — ${data.sku?.code ?? 'task'} now ${data.status === 'PENDING' ? 'Pending' : data.status}.`,
    );
    loadTasks();
    loadExceptions();
  };

  const handleReviewException = async (id: string) => {
    setExceptionMsg('');
    const res = await fetch(`http://localhost:3000/pick-tasks/exceptions/${id}/review`, { method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({}) });
    const data = await res.json();
    if (!res.ok) {
      setExceptionMsg(errorText(data, 'Could not mark this exception reviewed.'));
      return;
    }
    loadExceptions();
  };

  return (
    <div style={{ maxWidth: 1100, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1 style={{ textAlign: 'center' }}>Picking</h1>
      <p style={{ textAlign: 'center', color: '#666', marginTop: -8 }}>
        Claim the next task — no barcode needed, the queue is FIFO regardless of who claims it — then scan
        the pallet (whole-unit pick) or each individual unit (partial pick) after scanning the location.
      </p>

      <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>Pick a Trip</h3>
        {!activeTrip ? (
          <div>
            <button onClick={handleClaim} disabled={claimBusy}>
              {claimBusy ? 'Claiming...' : 'Claim Next Task'}
            </button>
            {claimError && <p style={{ color: 'crimson' }}>{claimError}</p>}
          </div>
        ) : (
          <div>
            <p>
              <strong>{activeTrip.task.sku.code}</strong> — {activeTrip.task.sku.description} — take{' '}
              <strong>{Number(activeTrip.quantity)}</strong> from <strong>{displayCode(activeTrip.task.fromLocation)}</strong> to{' '}
              <strong>{displayCode(activeTrip.task.toLocation)}</strong>
              {activeTrip.task.orderLine && (
                <> — Order {activeTrip.task.orderLine.order.orderNo} ({activeTrip.task.orderLine.order.destinationCity})</>
              )}
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <input
                placeholder="Scan source location..." value={locationCode}
                onChange={(e) => setLocationCode(e.target.value)}
                style={{ width: 220 }} autoFocus
              />
            </div>
            <div style={{ marginBottom: 8 }}>
              <label style={{ marginRight: 16 }}>
                <input type="radio" name="pickMode" checked={pickMode === 'pallet'} onChange={() => setPickMode('pallet')} /> Whole pallet
              </label>
              <label>
                <input type="radio" name="pickMode" checked={pickMode === 'unit'} onChange={() => setPickMode('unit')} /> Partial / individual units
              </label>
            </div>
            {pickMode === 'pallet' ? (
              <input
                placeholder="Scan pallet code..." value={palletCode}
                onChange={(e) => setPalletCode(e.target.value)}
                style={{ width: 220 }}
              />
            ) : (
              <div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    placeholder="Scan unit barcode..." value={unitBarcode}
                    onChange={(e) => setUnitBarcode(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addUnitBarcode()}
                    style={{ width: 220 }}
                  />
                  <button type="button" onClick={addUnitBarcode}>Add</button>
                </div>
                {unitBarcodes.length > 0 && (
                  <p style={{ fontSize: 13, color: '#444' }}>
                    Scanned {unitBarcodes.length}: {unitBarcodes.join(', ')}
                    <button type="button" onClick={() => setUnitBarcodes([])} style={{ marginLeft: 8 }}>Clear</button>
                  </p>
                )}
              </div>
            )}
            <div style={{ marginTop: 8 }}>
              <button onClick={handleCompleteTrip}>Complete</button>
              <button type="button" onClick={() => { setActiveTrip(null); resetCompleteForm(); }} style={{ marginLeft: 8 }}>Cancel</button>
              <button type="button" onClick={() => setShowReportProblem((s) => !s)} style={{ marginLeft: 8 }}>
                {showReportProblem ? '▾ Hide Report a Problem' : '▸ Report a Problem instead'}
              </button>
            </div>
            {completeError && <p style={{ color: 'crimson' }}>{completeError}</p>}

            {showReportProblem && (
              <div style={{ marginTop: 12, padding: 12, border: '1px dashed #b45309', borderRadius: 8 }}>
                <p style={{ margin: '0 0 8px', fontSize: 13, color: '#666' }}>
                  The assigned location genuinely doesn't have what's expected — this abandons the trip (no
                  units picked) and sends the task back for a new source.
                </p>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                  <select value={problemReason} onChange={(e) => setProblemReason(e.target.value)} style={{ padding: 6 }}>
                    <option value="EMPTY_BIN">Empty Bin</option>
                    <option value="WRONG_SKU">Wrong SKU</option>
                    <option value="DAMAGED">Damaged</option>
                    <option value="OTHER">Other</option>
                  </select>
                  <input
                    placeholder="Notes (optional)" value={problemNotes}
                    onChange={(e) => setProblemNotes(e.target.value)}
                    style={{ width: 260 }}
                  />
                  <button type="button" onClick={handleReportProblem}>Report Problem</button>
                </div>
                {problemError && <p style={{ color: 'crimson' }}>{problemError}</p>}
              </div>
            )}
          </div>
        )}
        {completeMsg && <p style={{ color: 'green' }}>{completeMsg}</p>}
      </div>

      {/* Operator assignment fairness (2026-09-14 gap-fix pass, item 3) — a
          live recommendation, not a hard lock. Works with no warehouse
          picked too, auto-scoped server-side to whatever the caller can
          actually access. */}
      {recommendation && (recommendation.recommendedOperator || recommendation.priorityTask) && (
        <div style={{ marginBottom: 16, padding: 12, border: '1px solid #1565c0', borderRadius: 8, background: 'rgba(21,101,192,0.06)', textAlign: 'center' }}>
          {recommendation.recommendedOperator && (
            <p style={{ margin: '0 0 4px', fontWeight: 'bold', color: recommendation.recommendedOperator.id === user?.id ? '#2e7d32' : '#1565c0' }}>
              {recommendation.recommendedOperator.id === user?.id
                ? "It's your turn — you've been free the longest."
                : `Next up: ${recommendation.recommendedOperator.name} (free since ${new Date(recommendation.recommendedOperator.freeSince).toLocaleTimeString()})`}
            </p>
          )}
          {recommendation.priorityTask && (
            <p style={{ margin: 0, fontSize: 13, color: '#444' }}>
              Priority — oldest staged stock: <strong>{recommendation.priorityTask.skuCode}</strong> at{' '}
              <strong>{recommendation.priorityTask.locationCode}</strong>, waiting since{' '}
              {new Date(recommendation.priorityTask.waitingSince).toLocaleString()}
            </p>
          )}
        </div>
      )}
      {taskMsg && <p style={{ textAlign: 'center' }}>{taskMsg}</p>}

      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center', gap: 8 }}>
        <select value={filterWarehouseId} onChange={(e) => setFilterWarehouseId(e.target.value)} style={{ width: 200, padding: 6 }}>
          <option value="">All warehouses</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>{w.code}</option>
          ))}
        </select>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 32 }}>
        <thead>
          <tr style={{ textAlign: 'center', borderBottom: '2px solid #ccc' }}>
            <th style={{ padding: 8 }}>SKU</th>
            <th style={{ padding: 8 }}>Order</th>
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
              <td style={{ padding: 8 }}>
                {t.orderLine ? `${t.orderLine.order.orderNo}${t.orderLine.isPriority ? ' ⭑' : ''}` : '—'}
              </td>
              <td style={{ padding: 8 }}>{displayCode(t.fromLocation)}</td>
              <td style={{ padding: 8 }}>{displayCode(t.toLocation)}</td>
              <td style={{ padding: 8 }}>{Number(t.quantity)}</td>
              <td style={{ padding: 8 }}>{Number(t.movedQuantity)}</td>
              <td style={{ padding: 8 }}>{STATUS_LABELS[t.status]}</td>
              <td style={{ padding: 8, whiteSpace: 'nowrap' }}>
                {t.status === 'NEEDS_SOURCE' && (
                  <button onClick={() => handleRetrySource(t.id)}>Retry Source</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {tasks.length === 0 && <p style={{ textAlign: 'center' }}>No picking tasks found.</p>}

      {canReviewExceptions && (
        <div style={{ marginTop: 32, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>Exceptions</h3>
          <p style={{ fontSize: 13, color: '#666', marginTop: -8 }}>
            Short Stock / Short Quantity are auto-logged by the system (shown as "System" below) whenever a task
            can't find enough source, either at allotment or after a retry. Empty Bin / Wrong SKU / Damaged / Other
            come from an operator's own explicit report. Mark Reviewed once you've looked into it.
          </p>
          {exceptionMsg && <p style={{ color: 'crimson' }}>{exceptionMsg}</p>}
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'center', borderBottom: '2px solid #ccc' }}>
                <th style={{ padding: 8 }}>Reason</th>
                <th style={{ padding: 8 }}>SKU</th>
                <th style={{ padding: 8 }}>Order</th>
                <th style={{ padding: 8 }}>Notes</th>
                <th style={{ padding: 8 }}>Reported By</th>
                <th style={{ padding: 8 }}>Reported At</th>
                <th style={{ padding: 8 }}>Reviewed</th>
                <th style={{ padding: 8 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {exceptions.map((e) => (
                <tr key={e.id} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: 8 }}>{e.reason.replace('_', ' ')}</td>
                  <td style={{ padding: 8 }}>{e.skuCode}</td>
                  <td style={{ padding: 8 }}>{e.orderNo}</td>
                  <td style={{ padding: 8 }}>{e.notes || '—'}</td>
                  <td style={{ padding: 8 }}>{e.reportedByName || 'System'}</td>
                  <td style={{ padding: 8 }}>{new Date(e.reportedAt).toLocaleString()}</td>
                  <td style={{ padding: 8 }}>
                    {e.reviewedAt ? `${e.reviewedByName} — ${new Date(e.reviewedAt).toLocaleString()}` : <span style={{ color: '#b45309' }}>Not yet</span>}
                  </td>
                  <td style={{ padding: 8 }}>
                    {!e.reviewedAt && <button onClick={() => handleReviewException(e.id)}>Mark Reviewed</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {exceptions.length === 0 && <p style={{ textAlign: 'center' }}>No exceptions.</p>}
        </div>
      )}
    </div>
  );
}

export default PickTasksPage;

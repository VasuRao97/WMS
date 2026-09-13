import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

// Analytics — the real, final module in the build order, deliberately
// separate from the earlier one-off Insights page (2026-08-29 — "not the
// same as the eventual full Analytics module"). Started 2026-09-02 with
// operator productivity at the Pallet level, per the client's own explicit
// call to start publishing this rather than leave it derivable-in-theory:
// "for each operator whats the time for him/her at a pallet level, we then
// get to know the productivity stuff." Two phases always reported
// separately per operator, never blended (marrying = loading cases onto a
// pallet; putaway = moving the closed pallet to its bin), plus abandoned
// Putaway claims flagged against the operator who claimed and never
// completed them ("we will then ask him/her why they didnt pick it up").
// See backend/src/analytics/analytics.service.ts for the computation and
// [[wms-putaway-design]] in memory for the design conversation.

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('token')}` };
}

function currentUser(): any {
  return localStorage.getItem('user') ? JSON.parse(localStorage.getItem('user')!) : null;
}

// Daily inward volume (2026-09-13, follow-on ask from the Inventory
// ledger-export conversation — see [[wms-inventory-design]]) — the first
// chart-based section in this app (client's own call: "real charts," not
// another table). Deliberately inward-only: outward has nothing genuine to
// show until Picking/Dispatch write real PICK/DISPATCH movements, and the
// client confirmed building inward-only now rather than holding the whole
// dashboard. "date" is a plain YYYY-MM-DD string, one row per calendar day
// in the requested range (zero-filled server-side — a quiet day is a real
// zero, not a gap).
type DailyInwardRow = { date: string; units: number; pallets: number };

function formatShortDate(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

type Warehouse = { id: string; code: string; name: string };
type MarryingRow = { operatorId: string; operatorName: string; palletCode: string; skuCode: string; scanCount: number; durationMinutes: number };
type PutawayRow = { operatorId: string; operatorName: string; palletCode: string; skuCode: string; tripCount: number; durationMinutes: number };
type AbandonedRow = { operatorId: string; operatorName: string; palletCode: string; skuCode: string; claimedAt: string };
// Pick Face (2026-09-05, see [[wms-putaway-design]]) — a third metric, NOT
// pallet-level like the two above (a PickFaceTask has no palletLoadId).
type PickFaceRow = { operatorId: string; operatorName: string; reason: 'REFILL' | 'EVICTION'; skuCode: string; fromCode: string; toCode: string; tripCount: number; durationMinutes: number };
const PICK_FACE_REASON_LABELS: Record<string, string> = { REFILL: 'Refill', EVICTION: 'Eviction' };

function formatMinutes(m: number) {
  if (m < 1) return '<1 min';
  if (m < 60) return `${Math.round(m)} min`;
  const h = Math.floor(m / 60);
  const rem = Math.round(m % 60);
  return `${h}h ${rem}m`;
}

function AnalyticsPage() {
  const user = currentUser();
  // Company-wide daily-inward is COMPANY_ADMIN-only — mirrors the backend's
  // own WAREHOUSE_SCOPED_ROLES check in AnalyticsService.dailyInward (a
  // Warehouse Manager/Supervisor must always narrow to one of their own),
  // same convention as the Inventory ledger export's own toggle.
  const canGoCompanyWide = user?.role === 'COMPANY_ADMIN';

  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [marrying, setMarrying] = useState<MarryingRow[] | null>(null);
  const [putaway, setPutaway] = useState<PutawayRow[] | null>(null);
  const [abandoned, setAbandoned] = useState<AbandonedRow[] | null>(null);
  const [pickFace, setPickFace] = useState<PickFaceRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  // Daily Inward Volume — its own scope/date controls, separate from the
  // operator-productivity tables below (same "own controls per section"
  // pattern the Inventory Ledger tab already established).
  const [dailyInwardCompanyWide, setDailyInwardCompanyWide] = useState(false);
  const [dailyInwardFrom, setDailyInwardFrom] = useState('');
  const [dailyInwardTo, setDailyInwardTo] = useState('');
  const [dailyInward, setDailyInward] = useState<DailyInwardRow[] | null>(null);
  const [dailyInwardError, setDailyInwardError] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('http://localhost:3000/warehouses', { headers: authHeaders() })
      .then((res) => (res.status === 401 ? null : res.json()))
      .then((data: Warehouse[] | null) => {
        if (!data) return;
        setWarehouses(data);
        if (data.length > 0) setWarehouseId(data[0].id);
      });
  }, []);

  useEffect(() => {
    if (!warehouseId) return;
    setLoading(true);
    setError('');
    fetch(`http://localhost:3000/analytics/operator-productivity?warehouseId=${warehouseId}`, { headers: authHeaders() })
      .then((res) => {
        if (res.status === 401) { localStorage.clear(); window.location.reload(); return null; }
        return res.json().then((data) => ({ ok: res.ok, data }));
      })
      .then((result) => {
        setLoading(false);
        if (!result) return;
        if (!result.ok) {
          setError(Array.isArray(result.data?.message) ? result.data.message.join(' | ') : result.data?.message || 'Could not load productivity data.');
          setMarrying(null); setPutaway(null); setAbandoned(null); setPickFace(null);
          return;
        }
        setMarrying(result.data.marrying);
        setPutaway(result.data.putaway);
        setAbandoned(result.data.abandoned);
        setPickFace(result.data.pickFace);
      });
  }, [warehouseId]);

  // Daily Inward Volume — its own effect since warehouseId is OPTIONAL here
  // (omitted entirely when dailyInwardCompanyWide is checked), unlike the
  // operator-productivity fetch above.
  useEffect(() => {
    if (!dailyInwardCompanyWide && !warehouseId) return;
    const params = new URLSearchParams();
    if (!dailyInwardCompanyWide && warehouseId) params.set('warehouseId', warehouseId);
    if (dailyInwardFrom) params.set('from', dailyInwardFrom);
    if (dailyInwardTo) params.set('to', dailyInwardTo);
    fetch(`http://localhost:3000/analytics/daily-inward?${params.toString()}`, { headers: authHeaders() })
      .then((res) => {
        if (res.status === 401) { localStorage.clear(); window.location.reload(); return null; }
        return res.json().then((data) => ({ ok: res.ok, data }));
      })
      .then((result) => {
        if (!result) return;
        if (!result.ok) {
          setDailyInwardError(Array.isArray(result.data?.message) ? result.data.message.join(' | ') : result.data?.message || 'Could not load daily inward volume.');
          setDailyInward(null);
          return;
        }
        setDailyInwardError('');
        setDailyInward(result.data);
      });
  }, [warehouseId, dailyInwardCompanyWide, dailyInwardFrom, dailyInwardTo]);

  return (
    <div style={{ maxWidth: 1000, margin: '40px auto', fontFamily: 'sans-serif', padding: '0 16px' }}>
      <h1 style={{ textAlign: 'center' }}>Analytics</h1>
      <p style={{ textAlign: 'center', color: '#888', fontSize: 13, marginTop: -8, marginBottom: 24 }}>
        Operator productivity — marrying and putaway time at the Pallet level, plus Pick Face reserve↔pick-face
        move time (SPR only) — always reported separately per operator, never blended.
      </p>

      <div style={{ display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center', marginBottom: 24 }}>
        <label style={{ fontSize: 13, fontWeight: 'bold' }}>Warehouse</label>
        <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} style={{ padding: 6, minWidth: 200 }}>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
          ))}
        </select>
      </div>

      {error && <p style={{ color: 'crimson', textAlign: 'center' }}>{error}</p>}
      {loading && <p style={{ textAlign: 'center', color: '#888' }}>Loading...</p>}

      <h3 style={{ textAlign: 'center', marginBottom: 4 }}>Daily Inward Volume</h3>
      <p style={{ textAlign: 'center', color: '#888', fontSize: 12, marginTop: 0, marginBottom: 8 }}>
        Stock genuinely NEW to the warehouse — Receipt + Return In only. Putaway's own internal
        staging→storage transfer isn't counted again here (every unit already counted once, at Receipt).
        Outward isn't shown yet — Picking/Dispatch don't exist as real modules, so there's nothing genuine
        to chart; this section grows a matching Outward pair the moment they do.
      </p>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        {canGoCompanyWide && (
          <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={dailyInwardCompanyWide} onChange={(e) => setDailyInwardCompanyWide(e.target.checked)} />
            All warehouses (company-wide)
          </label>
        )}
        <label style={{ fontSize: 13 }}>From</label>
        <input type="date" value={dailyInwardFrom} onChange={(e) => setDailyInwardFrom(e.target.value)} style={{ padding: 6 }} />
        <label style={{ fontSize: 13 }}>To</label>
        <input type="date" value={dailyInwardTo} onChange={(e) => setDailyInwardTo(e.target.value)} style={{ padding: 6 }} />
        <span style={{ fontSize: 11, color: '#aaa' }}>(blank = last 30 days)</span>
      </div>

      {dailyInwardError && <p style={{ color: 'crimson', textAlign: 'center' }}>{dailyInwardError}</p>}
      {dailyInward && (
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 32 }}>
          <div style={{ flex: '1 1 380px', minWidth: 320 }}>
            <p style={{ textAlign: 'center', fontSize: 13, fontWeight: 'bold', marginBottom: 4 }}>Units</p>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={dailyInward} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
                <XAxis dataKey="date" tickFormatter={formatShortDate} tick={{ fontSize: 11, fill: '#888' }} axisLine={{ stroke: '#ddd' }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#888' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip labelFormatter={(label) => formatShortDate(String(label))} formatter={(v) => [v, 'Units']} />
                <Bar dataKey="units" fill="#166534" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div style={{ flex: '1 1 380px', minWidth: 320 }}>
            <p style={{ textAlign: 'center', fontSize: 13, fontWeight: 'bold', marginBottom: 4 }}>
              Pallets <span style={{ fontWeight: 'normal', color: '#aaa' }}>(only counts palletized stock)</span>
            </p>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={dailyInward} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
                <XAxis dataKey="date" tickFormatter={formatShortDate} tick={{ fontSize: 11, fill: '#888' }} axisLine={{ stroke: '#ddd' }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#888' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip labelFormatter={(label) => formatShortDate(String(label))} formatter={(v) => [v, 'Pallets']} />
                <Bar dataKey="pallets" fill="#1d4ed8" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <h3 style={{ marginBottom: 4 }}>Pallet Marrying — time spent loading cases onto a pallet</h3>
      <p style={{ color: '#888', fontSize: 12, marginTop: 0, marginBottom: 8 }}>
        First scan to last scan an operator made on a given pallet. Two operators sharing one pallet's loading each
        get their own row.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 28 }}>
        <thead>
          <tr style={{ textAlign: 'center', borderBottom: '1px solid #ccc' }}>
            <th style={{ padding: 6 }}>Operator</th>
            <th style={{ padding: 6 }}>Pallet</th>
            <th style={{ padding: 6 }}>SKU</th>
            <th style={{ padding: 6 }}>Scans</th>
            <th style={{ padding: 6 }}>Time Spent</th>
          </tr>
        </thead>
        <tbody>
          {(marrying || []).map((r, i) => (
            <tr key={i} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
              <td style={{ padding: 6 }}>{r.operatorName}</td>
              <td style={{ padding: 6 }}>{r.palletCode}</td>
              <td style={{ padding: 6 }}>{r.skuCode}</td>
              <td style={{ padding: 6 }}>{r.scanCount}</td>
              <td style={{ padding: 6 }}>{formatMinutes(r.durationMinutes)}</td>
            </tr>
          ))}
          {marrying && marrying.length === 0 && (
            <tr><td colSpan={5} style={{ padding: 12, color: '#888' }}>No pallet marrying activity yet.</td></tr>
          )}
        </tbody>
      </table>

      <h3 style={{ marginBottom: 4 }}>Putaway — time spent moving a closed pallet to its bin</h3>
      <p style={{ color: '#888', fontSize: 12, marginTop: 0, marginBottom: 8 }}>
        Sum of claim-to-complete time across all trips an operator ran for a given pallet. A multi-trip pallet split
        across operators shows one row per operator.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 28 }}>
        <thead>
          <tr style={{ textAlign: 'center', borderBottom: '1px solid #ccc' }}>
            <th style={{ padding: 6 }}>Operator</th>
            <th style={{ padding: 6 }}>Pallet</th>
            <th style={{ padding: 6 }}>SKU</th>
            <th style={{ padding: 6 }}>Trips</th>
            <th style={{ padding: 6 }}>Time Spent</th>
          </tr>
        </thead>
        <tbody>
          {(putaway || []).map((r, i) => (
            <tr key={i} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
              <td style={{ padding: 6 }}>{r.operatorName}</td>
              <td style={{ padding: 6 }}>{r.palletCode}</td>
              <td style={{ padding: 6 }}>{r.skuCode}</td>
              <td style={{ padding: 6 }}>{r.tripCount}</td>
              <td style={{ padding: 6 }}>{formatMinutes(r.durationMinutes)}</td>
            </tr>
          ))}
          {putaway && putaway.length === 0 && (
            <tr><td colSpan={5} style={{ padding: 12, color: '#888' }}>No completed putaway trips yet.</td></tr>
          )}
        </tbody>
      </table>

      <h3 style={{ marginBottom: 4, color: 'crimson' }}>Abandoned Claims — flagged for follow-up</h3>
      <p style={{ color: '#888', fontSize: 12, marginTop: 0, marginBottom: 8 }}>
        A trip claimed at staging but never completed (auto-expires after 30 minutes) — flagged against the operator
        who claimed it, so it can be followed up on directly.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'center', borderBottom: '1px solid #ccc' }}>
            <th style={{ padding: 6 }}>Operator</th>
            <th style={{ padding: 6 }}>Pallet</th>
            <th style={{ padding: 6 }}>SKU</th>
            <th style={{ padding: 6 }}>Claimed At</th>
          </tr>
        </thead>
        <tbody>
          {(abandoned || []).map((r, i) => (
            <tr key={i} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
              <td style={{ padding: 6 }}>{r.operatorName}</td>
              <td style={{ padding: 6 }}>{r.palletCode}</td>
              <td style={{ padding: 6 }}>{r.skuCode}</td>
              <td style={{ padding: 6 }}>{new Date(r.claimedAt).toLocaleString()}</td>
            </tr>
          ))}
          {abandoned && abandoned.length === 0 && (
            <tr><td colSpan={4} style={{ padding: 12, color: '#888' }}>No abandoned claims.</td></tr>
          )}
        </tbody>
      </table>

      <h3 style={{ marginBottom: 4, marginTop: 28 }}>Pick Face — time spent on reserve↔pick-face moves</h3>
      <p style={{ color: '#888', fontSize: 12, marginTop: 0, marginBottom: 8 }}>
        Not pallet-level like the reports above — a Pick Face task is a plain SKU move, not a Pallet
        consolidation concept. Sum of claim-to-complete time per operator per task; a multi-trip task split
        across operators shows one row per operator.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'center', borderBottom: '1px solid #ccc' }}>
            <th style={{ padding: 6 }}>Operator</th>
            <th style={{ padding: 6 }}>Reason</th>
            <th style={{ padding: 6 }}>SKU</th>
            <th style={{ padding: 6 }}>From</th>
            <th style={{ padding: 6 }}>To</th>
            <th style={{ padding: 6 }}>Trips</th>
            <th style={{ padding: 6 }}>Time Spent</th>
          </tr>
        </thead>
        <tbody>
          {(pickFace || []).map((r, i) => (
            <tr key={i} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
              <td style={{ padding: 6 }}>{r.operatorName}</td>
              <td style={{ padding: 6 }}>{PICK_FACE_REASON_LABELS[r.reason]}</td>
              <td style={{ padding: 6 }}>{r.skuCode}</td>
              <td style={{ padding: 6 }}>{r.fromCode}</td>
              <td style={{ padding: 6 }}>{r.toCode}</td>
              <td style={{ padding: 6 }}>{r.tripCount}</td>
              <td style={{ padding: 6 }}>{formatMinutes(r.durationMinutes)}</td>
            </tr>
          ))}
          {pickFace && pickFace.length === 0 && (
            <tr><td colSpan={7} style={{ padding: 12, color: '#888' }}>No completed Pick Face trips yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default AnalyticsPage;

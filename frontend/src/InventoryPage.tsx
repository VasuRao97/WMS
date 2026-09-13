import { useEffect, useState } from 'react';
import { STORAGE_TYPE_OPTIONS, labelFor, type Warehouse } from './LocationsPage';

// Inventory — the first real "what's on hand" screen this app has ever had
// (2026-09-13, closing the long-flagged ROADMAP gap: "there is still no
// screen anywhere showing what's on hand at Location X"). Client-provided
// sample sheet drove the exact column set; two views confirmed directly —
// Line Items (one row per bin/pallet) and a SKU-level summary (for an
// at-a-glance ABC/FMS read), never blended into one table. Both reuse the
// ALREADY-COMPUTED per-warehouse ABC/FMS classification (confirmed
// directly, not a new calculation) — same override-when-known chain
// suggestBin() itself uses (computed class first, falling back to the
// manually-set/imported one). Scoped per warehouse (confirmed), matching
// every other report page in this app (Insights/Analytics/Storage
// Utilization all are).

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('token')}` };
}

// Shape of the `user` object /auth/login and /auth/register store into
// localStorage (see backend/src/auth/auth.service.ts's
// `{ id, email, role, companyId }`) — not the full User row.
interface CurrentUser {
  id: string;
  email: string;
  role: string;
  companyId: string | null;
}

function currentUser(): CurrentUser | null {
  return localStorage.getItem('user') ? JSON.parse(localStorage.getItem('user')!) : null;
}

// Excel/JSON split for movement-type labels, same convention as
// STORAGE_TYPE_LABELS (backend, validation) vs. STORAGE_TYPE_OPTIONS/
// labelFor (frontend, display) elsewhere in this codebase — this is the
// frontend-display half; the backend's own copy (Excel-export-only, see
// InventoryService) is separate on purpose.
const MOVEMENT_TYPE_OPTIONS = [
  { value: 'RECEIPT', label: 'Receipt' },
  { value: 'PUTAWAY_OUT', label: 'Putaway Out' },
  { value: 'PUTAWAY_IN', label: 'Putaway In' },
  { value: 'PICK', label: 'Pick' },
  { value: 'DISPATCH', label: 'Dispatch' },
  { value: 'RETURN_IN', label: 'Return In' },
  { value: 'ADJUSTMENT', label: 'Adjustment' },
  { value: 'PICK_FACE_REPLENISH_OUT', label: 'Pick Face Replenish Out' },
  { value: 'PICK_FACE_REPLENISH_IN', label: 'Pick Face Replenish In' },
];

type LineItemRow = {
  skuCode: string;
  description: string;
  quantity: number;
  agingDays: number | null;
  storageType: string;
  palletCode: string | null;
  binCode: string;
  category: string | null;
  lastTouchedAt: string;
  abcClass: string;
  fmsClass: string | null;
};

type SkuSummaryRow = {
  skuCode: string;
  description: string;
  quantity: number;
  agingDays: number | null;
  category: string | null;
  binCount: number;
  lastTouchedAt: string;
  abcClass: string;
  fmsClass: string | null;
};

// Transaction-level ledger row — one per raw StockMovement, unsummed (the
// 2026-09-13 follow-on ask, see [[wms-inventory-design]]). Deliberately no
// running-balance field here — raw rows only, confirmed directly.
type LedgerRow = {
  createdAt: string;
  movementType: string;
  quantity: number;
  referenceType: string;
  referenceId: string;
  notes: string | null;
  receivedDate: string | null;
  warehouseCode: string;
  skuCode: string;
  skuDescription: string;
  // Real transfers (Putaway/Pick-Face replenish trips) get BOTH filled —
  // each of the pair's two raw rows shows the trip's real source+destination.
  // Everything else fills whichever side its signed quantity implies
  // (Receipt/Return In/positive-Adjustment -> toLocation only; Pick/Dispatch/
  // negative-Adjustment -> fromLocation only) — see InventoryService's own
  // comment for the full reasoning. 2026-09-13 follow-on ask, replaces what
  // used to be a single "Bin/Location" column.
  fromLocation: string | null;
  toLocation: string | null;
  storageType: string;
  palletCode: string | null;
  createdByName: string;
};

const ABC_COLORS: Record<string, string> = { A: '#166534', B: '#1d4ed8', C: '#7c3aed', D: '#6b7280' };
const FMS_COLORS: Record<string, string> = { F: '#166534', M: '#a16207', S: '#b91c1c' };

function ClassBadge({ value, colors }: { value: string | null; colors: Record<string, string> }) {
  if (!value) return <span style={{ color: '#aaa' }}>—</span>;
  return <span style={{ fontWeight: 'bold', color: colors[value] || '#333' }}>{value}</span>;
}

function InventoryPage() {
  const user = currentUser();
  // Company-wide ledger dump is COMPANY_ADMIN-only — mirrors the backend's
  // own WAREHOUSE_SCOPED_ROLES check in InventoryService.ledgerWhere (a
  // Warehouse Manager/Supervisor must always narrow to one of their own
  // warehouses; SUPER_ADMIN isn't in CAN_VIEW_INVENTORY's own tier at all,
  // so it's not worth accounting for here).
  const canGoCompanyWide = user?.role === 'COMPANY_ADMIN';

  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [view, setView] = useState<'lineItems' | 'skuSummary' | 'ledger'>('lineItems');
  const [lineItems, setLineItems] = useState<LineItemRow[] | null>(null);
  const [skuSummary, setSkuSummary] = useState<SkuSummaryRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [searchText, setSearchText] = useState('');

  // Ledger-only state — a raw transaction log, not another balance
  // snapshot, so it gets its own scope/date controls rather than reusing
  // the Line Items/SKU Summary ones.
  const [ledgerRows, setLedgerRows] = useState<LedgerRow[] | null>(null);
  const [companyWide, setCompanyWide] = useState(false);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [exporting, setExporting] = useState(false);

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
    if (view === 'ledger') return; // handled by its own effect below — different params, optional warehouseId
    if (!warehouseId) return;
    setLoading(true);
    setError('');
    const endpoint = view === 'lineItems' ? 'line-items' : 'sku-summary';
    fetch(`http://localhost:3000/inventory/${endpoint}?warehouseId=${warehouseId}`, { headers: authHeaders() })
      .then((res) => {
        if (res.status === 401) { localStorage.clear(); window.location.reload(); return null; }
        return res.json().then((data) => ({ ok: res.ok, data }));
      })
      .then((result) => {
        setLoading(false);
        if (!result) return;
        if (!result.ok) {
          setError(Array.isArray(result.data?.message) ? result.data.message.join(' | ') : result.data?.message || 'Could not load inventory.');
          setLineItems(null);
          setSkuSummary(null);
          return;
        }
        if (view === 'lineItems') setLineItems(result.data);
        else setSkuSummary(result.data);
      });
  }, [warehouseId, view]);

  // Ledger — its own effect since warehouseId is OPTIONAL here (omitted
  // entirely when companyWide is checked), unlike Line Items/SKU Summary's
  // always-required one above.
  useEffect(() => {
    if (view !== 'ledger') return;
    if (!companyWide && !warehouseId) return;
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    if (!companyWide && warehouseId) params.set('warehouseId', warehouseId);
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);
    fetch(`http://localhost:3000/inventory/ledger?${params.toString()}`, { headers: authHeaders() })
      .then((res) => {
        if (res.status === 401) { localStorage.clear(); window.location.reload(); return null; }
        return res.json().then((data) => ({ ok: res.ok, data }));
      })
      .then((result) => {
        setLoading(false);
        if (!result) return;
        if (!result.ok) {
          setError(Array.isArray(result.data?.message) ? result.data.message.join(' | ') : result.data?.message || 'Could not load the ledger.');
          setLedgerRows(null);
          return;
        }
        setLedgerRows(result.data);
      });
  }, [view, warehouseId, companyWide, fromDate, toDate]);

  const handleExportLedger = () => {
    setExporting(true);
    const params = new URLSearchParams();
    if (!companyWide && warehouseId) params.set('warehouseId', warehouseId);
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);
    fetch(`http://localhost:3000/inventory/ledger/export?${params.toString()}`, { headers: authHeaders() })
      .then((res) => res.blob())
      .then((blob) => {
        setExporting(false);
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'Inventory_Ledger_Export.xlsx';
        a.click();
        window.URL.revokeObjectURL(url);
      });
  };

  const searchLower = searchText.trim().toLowerCase();
  const filteredLineItems = (lineItems || []).filter((r) => {
    if (!searchLower) return true;
    return [r.skuCode, r.description, r.binCode, r.palletCode, r.category].filter(Boolean).join(' ').toLowerCase().includes(searchLower);
  });
  const filteredSkuSummary = (skuSummary || []).filter((r) => {
    if (!searchLower) return true;
    return [r.skuCode, r.description, r.category].filter(Boolean).join(' ').toLowerCase().includes(searchLower);
  });
  const filteredLedgerRows = (ledgerRows || []).filter((r) => {
    if (!searchLower) return true;
    return [r.skuCode, r.skuDescription, r.fromLocation, r.toLocation, r.palletCode, r.warehouseCode, r.createdByName]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(searchLower);
  });

  return (
    <div style={{ maxWidth: 1200, margin: '40px auto', fontFamily: 'sans-serif', padding: '0 16px' }}>
      <h1 style={{ textAlign: 'center' }}>Inventory</h1>
      <p style={{ textAlign: 'center', color: '#888', fontSize: 13, marginTop: -8, marginBottom: 24 }}>
        What's on hand, right now — always derived live from the stock ledger, never a stored count. Line Items shows
        every bin/pallet individually; SKU Summary rolls each SKU up into one row for a quick ABC/FMS read; Ledger is
        the raw transaction log itself — every individual inward/outward movement, unsummed.
      </p>

      <div style={{ display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13, fontWeight: 'bold' }}>Warehouse</label>
        <select
          value={warehouseId}
          onChange={(e) => setWarehouseId(e.target.value)}
          disabled={view === 'ledger' && companyWide}
          style={{ padding: 6, minWidth: 200 }}
        >
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
          ))}
        </select>
        <button type="button" onClick={() => setView('lineItems')} disabled={view === 'lineItems'}>Line Items</button>
        <button type="button" onClick={() => setView('skuSummary')} disabled={view === 'skuSummary'}>SKU Summary</button>
        <button type="button" onClick={() => setView('ledger')} disabled={view === 'ledger'}>Ledger</button>
        <input
          placeholder={view === 'ledger'
            ? 'Search SKU / description / bin / pallet / warehouse / operator...'
            : 'Search SKU / description / bin / pallet / category...'}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          style={{ padding: 6, minWidth: 260 }}
        />
      </div>

      {view === 'ledger' && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
          {canGoCompanyWide && (
            <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                type="checkbox"
                checked={companyWide}
                onChange={(e) => setCompanyWide(e.target.checked)}
              />
              All warehouses (company-wide)
            </label>
          )}
          <label style={{ fontSize: 13 }}>From</label>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={{ padding: 6 }} />
          <label style={{ fontSize: 13 }}>To</label>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={{ padding: 6 }} />
          <button type="button" onClick={handleExportLedger} disabled={exporting}>
            {exporting ? 'Exporting...' : 'Export to Excel'}
          </button>
        </div>
      )}

      {error && <p style={{ color: 'crimson', textAlign: 'center' }}>{error}</p>}
      {loading && <p style={{ textAlign: 'center', color: '#888' }}>Loading...</p>}

      {!loading && !error && view === 'lineItems' && (
        <>
          <p style={{ textAlign: 'center', color: '#888', fontSize: 12, marginTop: 0 }}>
            Showing {filteredLineItems.length} of {lineItems?.length ?? 0} occupied bin/pallet rows.
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'center', borderBottom: '1px solid #ccc' }}>
                <th style={{ padding: 6 }}>SL</th>
                <th style={{ padding: 6 }}>SKU Code</th>
                <th style={{ padding: 6 }}>Material Desc</th>
                <th style={{ padding: 6 }}>Quantity</th>
                <th style={{ padding: 6 }}>Aging (days)</th>
                <th style={{ padding: 6 }}>Storage System</th>
                <th style={{ padding: 6 }}>Pallet No</th>
                <th style={{ padding: 6 }}>Bin No</th>
                <th style={{ padding: 6 }}>Category</th>
                <th style={{ padding: 6 }}>Last Touched On</th>
                <th style={{ padding: 6 }}>ABC</th>
                <th style={{ padding: 6 }}>FMS</th>
              </tr>
            </thead>
            <tbody>
              {filteredLineItems.map((r, i) => (
                <tr key={i} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: 6 }}>{i + 1}</td>
                  <td style={{ padding: 6 }}>{r.skuCode}</td>
                  <td style={{ padding: 6 }}>{r.description}</td>
                  <td style={{ padding: 6 }}>{r.quantity}</td>
                  <td style={{ padding: 6 }}>{r.agingDays ?? '—'}</td>
                  <td style={{ padding: 6 }}>{labelFor(STORAGE_TYPE_OPTIONS, r.storageType)}</td>
                  <td style={{ padding: 6 }}>{r.palletCode || '—'}</td>
                  <td style={{ padding: 6 }}>{r.binCode}</td>
                  <td style={{ padding: 6 }}>{r.category || '—'}</td>
                  <td style={{ padding: 6 }}>{new Date(r.lastTouchedAt).toLocaleString()}</td>
                  <td style={{ padding: 6 }}><ClassBadge value={r.abcClass} colors={ABC_COLORS} /></td>
                  <td style={{ padding: 6 }}><ClassBadge value={r.fmsClass} colors={FMS_COLORS} /></td>
                </tr>
              ))}
              {filteredLineItems.length === 0 && (
                <tr><td colSpan={12} style={{ padding: 12, color: '#888' }}>No stock on hand{searchLower ? ' matching this search' : ''}.</td></tr>
              )}
            </tbody>
          </table>
        </>
      )}

      {!loading && !error && view === 'skuSummary' && (
        <>
          <p style={{ textAlign: 'center', color: '#888', fontSize: 12, marginTop: 0 }}>
            Showing {filteredSkuSummary.length} of {skuSummary?.length ?? 0} SKUs currently on hand. "Aging" is the
            OLDEST lot found for that SKU — the worst case, not an average, so a genuinely stale batch never hides
            behind newer stock of the same SKU.
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'center', borderBottom: '1px solid #ccc' }}>
                <th style={{ padding: 6 }}>SL</th>
                <th style={{ padding: 6 }}>SKU Code</th>
                <th style={{ padding: 6 }}>Material Desc</th>
                <th style={{ padding: 6 }}>Total Quantity</th>
                <th style={{ padding: 6 }}>Oldest Lot Aging (days)</th>
                <th style={{ padding: 6 }}>Category</th>
                <th style={{ padding: 6 }}>Bins/Pallets</th>
                <th style={{ padding: 6 }}>Last Touched On</th>
                <th style={{ padding: 6 }}>ABC</th>
                <th style={{ padding: 6 }}>FMS</th>
              </tr>
            </thead>
            <tbody>
              {filteredSkuSummary.map((r, i) => (
                <tr key={i} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: 6 }}>{i + 1}</td>
                  <td style={{ padding: 6 }}>{r.skuCode}</td>
                  <td style={{ padding: 6 }}>{r.description}</td>
                  <td style={{ padding: 6 }}>{r.quantity}</td>
                  <td style={{ padding: 6 }}>{r.agingDays ?? '—'}</td>
                  <td style={{ padding: 6 }}>{r.category || '—'}</td>
                  <td style={{ padding: 6 }}>{r.binCount}</td>
                  <td style={{ padding: 6 }}>{new Date(r.lastTouchedAt).toLocaleString()}</td>
                  <td style={{ padding: 6 }}><ClassBadge value={r.abcClass} colors={ABC_COLORS} /></td>
                  <td style={{ padding: 6 }}><ClassBadge value={r.fmsClass} colors={FMS_COLORS} /></td>
                </tr>
              ))}
              {filteredSkuSummary.length === 0 && (
                <tr><td colSpan={10} style={{ padding: 12, color: '#888' }}>No stock on hand{searchLower ? ' matching this search' : ''}.</td></tr>
              )}
            </tbody>
          </table>
        </>
      )}

      {!loading && !error && view === 'ledger' && (
        <>
          <p style={{ textAlign: 'center', color: '#888', fontSize: 12, marginTop: 0 }}>
            Showing {filteredLedgerRows.length} of {ledgerRows?.length ?? 0} raw movement rows
            {companyWide ? ' across all warehouses' : ''}
            {fromDate || toDate ? ` (${fromDate || 'earliest'} to ${toDate || 'now'})` : ' (entire history)'}.
            Raw rows only — no running balance; sum the Quantity column yourself for a balance as of any point.
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'center', borderBottom: '1px solid #ccc' }}>
                <th style={{ padding: 6 }}>SL</th>
                <th style={{ padding: 6 }}>Date/Time</th>
                <th style={{ padding: 6 }}>Warehouse</th>
                <th style={{ padding: 6 }}>SKU Code</th>
                <th style={{ padding: 6 }}>Material Desc</th>
                <th style={{ padding: 6 }}>Movement Type</th>
                <th style={{ padding: 6 }}>Quantity</th>
                <th style={{ padding: 6 }}>From Location</th>
                <th style={{ padding: 6 }}>To Location</th>
                <th style={{ padding: 6 }}>Pallet No</th>
                <th style={{ padding: 6 }}>Reference</th>
                <th style={{ padding: 6 }}>Created By</th>
              </tr>
            </thead>
            <tbody>
              {filteredLedgerRows.map((r, i) => (
                <tr key={i} style={{ textAlign: 'center', borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: 6 }}>{i + 1}</td>
                  <td style={{ padding: 6 }}>{new Date(r.createdAt).toLocaleString()}</td>
                  <td style={{ padding: 6 }}>{r.warehouseCode}</td>
                  <td style={{ padding: 6 }}>{r.skuCode}</td>
                  <td style={{ padding: 6 }}>{r.skuDescription}</td>
                  <td style={{ padding: 6 }}>{labelFor(MOVEMENT_TYPE_OPTIONS, r.movementType)}</td>
                  <td style={{ padding: 6, color: r.quantity < 0 ? '#b91c1c' : '#166534', fontWeight: 'bold' }}>
                    {r.quantity > 0 ? `+${r.quantity}` : r.quantity}
                  </td>
                  <td style={{ padding: 6 }}>{r.fromLocation || '—'}</td>
                  <td style={{ padding: 6 }}>{r.toLocation || '—'}</td>
                  <td style={{ padding: 6 }}>{r.palletCode || '—'}</td>
                  <td style={{ padding: 6 }}>{r.referenceType} / {r.referenceId.slice(0, 8)}</td>
                  <td style={{ padding: 6 }}>{r.createdByName || '—'}</td>
                </tr>
              ))}
              {filteredLedgerRows.length === 0 && (
                <tr><td colSpan={12} style={{ padding: 12, color: '#888' }}>No movements{searchLower ? ' matching this search' : ' in this range'}.</td></tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

export default InventoryPage;

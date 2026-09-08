import { RACK_STORAGE_TYPES, STORAGE_TYPE_OPTIONS, ZONE_TYPE_OPTIONS, labelFor, type Location } from './LocationsPage';
import { posOf } from './locationBoxUtils';
import { ABC_CLASS_COLORS, FMS_CLASS_COLORS, type Occupancy } from './occupancyColors';

// Click-to-inspect side panel — originally built for Locations3DView.tsx
// (2026-09-05, closing the original 2026-08-25 2D Plan View's own deferred
// "click-to-inspect" item, landing in 3D first). Extracted here so 2D's own
// click-to-inspect (same-day "upgrade mode" backlog, item 2) shows IDENTICAL
// detail in the identical shape — one component, two callers, same
// convention as STORAGE_TYPE_COLORS/occupancyColors.ts.

// Always shows the -D{n} suffix when a depth value exists at all, rather
// than re-deriving whether this position genuinely has more than one depth
// (2D's box-building own rule for its OWN label) — the "Depth position"
// field in the panel body already gives the precise number either way,
// this header is just a convenience label.
export function buildRackName(l: Location): string {
  if (!RACK_STORAGE_TYPES.includes(l.storageType)) return l.code;
  const parts = [l.flankNumber != null ? `R${l.flankNumber}` : 'R?', posOf(l) ?? '?'];
  if (l.depth != null) parts.push(`D${l.depth}`);
  return parts.join('-');
}

// `occupancy` is optional and comes from whatever `Occupancy[]` the caller
// already fetched for the overlay (2026-09-05) — the panel doesn't fetch
// anything of its own, it just renders whichever row (if any) matches this
// location's id. Added 2026-09-06 ("I need SKU details in it also," asked
// after clicking a bin only showed its structural fields) — every caller
// already had this data in hand for coloring, so this is a pure passthrough,
// not a new fetch. A location with no current occupant (or a caller that
// hasn't loaded occupancy at all, e.g. structural-only Structural mode)
// shows a plain "Empty" line rather than omitting the section — confirms
// there's genuinely nothing there rather than looking like an oversight.
export function DetailPanel({ location, occupancy, onClose }: { location: Location; occupancy?: Occupancy; onClose: () => void }) {
  const rackName = buildRackName(location);
  return (
    <div style={{ position: 'absolute', top: 12, right: 12, width: 240, background: '#fff', border: '1px solid #ccc', borderRadius: 8, padding: 12, fontSize: 13, boxShadow: '0 2px 8px rgba(0,0,0,0.12)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong>{rackName}</strong>
        <button type="button" onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 14 }}>✕</button>
      </div>
      <p style={{ margin: '4px 0' }}><strong>Code:</strong> {location.code}</p>
      <p style={{ margin: '4px 0' }}><strong>Zone Type:</strong> {labelFor(ZONE_TYPE_OPTIONS, location.zoneType)}</p>
      <p style={{ margin: '4px 0' }}><strong>Storage Type:</strong> {labelFor(STORAGE_TYPE_OPTIONS, location.storageType)}</p>
      <p style={{ margin: '4px 0' }}><strong>Category:</strong> {location.category?.name || '—'}</p>
      {RACK_STORAGE_TYPES.includes(location.storageType) ? (
        <>
          <p style={{ margin: '4px 0' }}><strong>Level:</strong> {location.level ?? '—'}</p>
          <p style={{ margin: '4px 0' }}><strong>Depth position:</strong> {location.depth ?? 1}</p>
        </>
      ) : (
        <>
          <p style={{ margin: '4px 0' }}><strong>Dimensions (D×W×H):</strong> {location.depth ?? 1}×{location.width ?? 1}×{location.height ?? 1}</p>
          {/* Depth Tier (2026-09-07) — only shown once it's actually in
              play (a plain single-tier bin, the common case, stays exactly
              as it read before this field existed) — which stacked bin,
              going away from the aisle, this one is. */}
          {location.storageType === 'GROUND_FLOOR' && (location.depthTier ?? 1) > 1 && (
            <p style={{ margin: '4px 0' }}><strong>Depth Tier:</strong> {location.depthTier} (stacked back-to-back from the aisle)</p>
          )}
        </>
      )}
      <p style={{ margin: '4px 0' }}><strong>Status:</strong> {location.isActive ? 'Active' : 'Inactive'}</p>
      <hr style={{ margin: '8px 0', border: 'none', borderTop: '1px solid #eee' }} />
      {occupancy ? (
        <>
          <p style={{ margin: '4px 0' }}><strong>Occupant SKU:</strong> {occupancy.skuCode ?? '—'}</p>
          <p style={{ margin: '4px 0' }}>
            <strong>Class:</strong>{' '}
            <span style={{ padding: '1px 6px', borderRadius: 4, background: ABC_CLASS_COLORS[occupancy.abcClass]?.fill, border: `1px solid ${ABC_CLASS_COLORS[occupancy.abcClass]?.stroke}` }}>
              {occupancy.abcClass}
            </span>
          </p>
          <p style={{ margin: '4px 0' }}>
            {/* FMS (2026-09-08) — no manual-class fallback exists, so a null
                value is real and expected (ABC-class D, or FMS not yet
                computed for this warehouse), not an error. */}
            <strong>FMS Class:</strong>{' '}
            {occupancy.fmsClass ? (
              <span style={{ padding: '1px 6px', borderRadius: 4, background: FMS_CLASS_COLORS[occupancy.fmsClass]?.fill, border: `1px solid ${FMS_CLASS_COLORS[occupancy.fmsClass]?.stroke}` }}>
                {occupancy.fmsClass}
              </span>
            ) : '—'}
          </p>
          <p style={{ margin: '4px 0' }}><strong>Category:</strong> {occupancy.categoryName ?? '—'}</p>
          {occupancy.quantity != null && <p style={{ margin: '4px 0' }}><strong>On-hand Qty:</strong> {occupancy.quantity}</p>}
        </>
      ) : (
        <p style={{ margin: '4px 0', color: '#888' }}>Empty — no current occupant.</p>
      )}
    </div>
  );
}

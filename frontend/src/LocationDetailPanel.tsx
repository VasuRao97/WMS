import { RACK_STORAGE_TYPES, STORAGE_TYPE_OPTIONS, ZONE_TYPE_OPTIONS, labelFor, type Location } from './LocationsPage';
import { posOf } from './locationBoxUtils';

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

export function DetailPanel({ location, onClose }: { location: Location; onClose: () => void }) {
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
        <p style={{ margin: '4px 0' }}><strong>Dimensions (D×W×H):</strong> {location.depth ?? 1}×{location.width ?? 1}×{location.height ?? 1}</p>
      )}
      <p style={{ margin: '4px 0' }}><strong>Status:</strong> {location.isActive ? 'Active' : 'Inactive'}</p>
    </div>
  );
}

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
};

function CompanySettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [detentionCostPerDay, setDetentionCostPerDay] = useState('');
  const [detentionFreeHours, setDetentionFreeHours] = useState('');
  const [detentionAlertHours, setDetentionAlertHours] = useState('');
  const [detentionEscalationHours, setDetentionEscalationHours] = useState('');
  const [allowErpInboundPush, setAllowErpInboundPush] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [keyError, setKeyError] = useState('');
  const [regenerating, setRegenerating] = useState(false);

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
      });
  };

  useEffect(() => {
    load();
  }, []);

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

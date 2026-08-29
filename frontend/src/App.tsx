import { useEffect, useRef, useState } from 'react';
import WarehousesPage from './WarehousesPage';
import SkusPage from './SkusPage';
import LoginPage from './LoginPage';
import CustomersPage from './CustomersPage';
import UsersPage from './UsersPage';
import LocationsPage from './LocationsPage';
import GateYardPage from './GateYardPage';
import VehicleDriverPage from './VehicleDriverPage';
import CompanySettingsPage from './CompanySettingsPage';
import InboundOrdersPage from './InboundOrdersPage';
import DockDoorsPage from './DockDoorsPage';
import EquipmentPage from './EquipmentPage';
import PutawayPage from './PutawayPage';
import InsightsPage from './InsightsPage';

// OPERATOR has zero master-data visibility, including the Users tab itself —
// mirrors UsersController's server-side @Roles() gate (see CLAUDE.md).
// SECURITY_SUPERVISOR (2026-08-27) is included here even though it has no
// access to the other master-data tabs — it's the one exception, needed to
// manage the OPERATOR accounts under it.
const CAN_MANAGE_USERS = ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR', 'SECURITY_SUPERVISOR'];
// Same tier as InsightsController's own @Roles() gate on the backend
// (MASTER_DATA_READ_ROLES) — Operator/Security Supervisor excluded, same
// "zero visibility, surface is a task screen" reasoning as every other
// master-data-tier read.
const CAN_VIEW_INSIGHTS = ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR'];

type Tab = 'warehouses' | 'skus' | 'customers' | 'users' | 'locations' | 'gateyard' | 'vehicledriver' | 'companysettings' | 'inboundorders' | 'dockdoors' | 'equipment' | 'putaway' | 'insights';

// The six master-data pages, clubbed under one "Masters" dropdown for
// simplicity (2026-08-27, the client's own call — the nav bar was getting
// crowded as more pages got added, and these six are all the same kind of
// thing: manage a list of master records, not a daily operational
// workflow). Gate & Yard / Inbound Orders / Company Settings stay as
// standalone top-level tabs, unchanged, per the client's explicit "rest you
// can keep as it is for now."
const MASTER_TABS: { tab: Tab; label: string }[] = [
  { tab: 'warehouses', label: 'Warehouses' },
  { tab: 'skus', label: 'SKUs' },
  { tab: 'customers', label: 'Customers' },
  { tab: 'locations', label: 'Locations' },
  { tab: 'dockdoors', label: 'Dock Doors' },
  { tab: 'equipment', label: 'Equipment (MHE)' },
  { tab: 'vehicledriver', label: 'Vehicle & Driver Master' },
  { tab: 'users', label: 'Users' },
];

function App() {
  const [tab, setTab] = useState<Tab>('warehouses');
  const [mastersOpen, setMastersOpen] = useState(false);
  const mastersRef = useRef<HTMLDivElement | null>(null);
  const [user, setUser] = useState<any>(
    localStorage.getItem('user') ? JSON.parse(localStorage.getItem('user')!) : null,
  );

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
  };

  // Close the Masters dropdown on an outside click — plain DOM listener,
  // no extra library, matching this codebase's "no component library"
  // convention.
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (mastersRef.current && !mastersRef.current.contains(e.target as Node)) setMastersOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  if (!user) {
    return (
      <LoginPage
        onLoginSuccess={() => {
          setUser(JSON.parse(localStorage.getItem('user')!));
        }}
      />
    );
  }

  const visibleMasterTabs = MASTER_TABS.filter((m) => m.tab !== 'users' || CAN_MANAGE_USERS.includes(user?.role));
  const isMasterTabActive = visibleMasterTabs.some((m) => m.tab === tab);

  return (
    <div>
      <nav style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 16, borderBottom: '1px solid #ccc', fontFamily: 'sans-serif' }}>
        <div ref={mastersRef} style={{ position: 'relative' }}>
          <button onClick={() => setMastersOpen(!mastersOpen)} style={{ fontWeight: isMasterTabActive ? 'bold' : 'normal' }}>
            Masters ▾
          </button>
          {mastersOpen && (
            <div
              style={{
                position: 'absolute', top: '100%', left: 0, marginTop: 4, background: '#fff', border: '1px solid #ccc',
                borderRadius: 6, boxShadow: '0 2px 8px rgba(0,0,0,0.15)', zIndex: 1000, minWidth: 200, display: 'flex', flexDirection: 'column',
              }}
            >
              {visibleMasterTabs.map((m) => (
                <button
                  key={m.tab}
                  onClick={() => { setTab(m.tab); setMastersOpen(false); }}
                  style={{
                    textAlign: 'left', padding: '8px 12px', border: 'none', background: tab === m.tab ? '#f0f0f0' : 'transparent',
                    fontWeight: tab === m.tab ? 'bold' : 'normal', cursor: 'pointer',
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button onClick={() => setTab('gateyard')} style={{ fontWeight: tab === 'gateyard' ? 'bold' : 'normal' }}>
          Gate &amp; Yard
        </button>
        {CAN_VIEW_INSIGHTS.includes(user?.role) && (
          <button onClick={() => setTab('insights')} style={{ fontWeight: tab === 'insights' ? 'bold' : 'normal' }}>
            Insights
          </button>
        )}
        <button onClick={() => setTab('inboundorders')} style={{ fontWeight: tab === 'inboundorders' ? 'bold' : 'normal' }}>
          Inbound Orders
        </button>
        <button onClick={() => setTab('putaway')} style={{ fontWeight: tab === 'putaway' ? 'bold' : 'normal' }}>
          Putaway
        </button>
        {user?.role === 'COMPANY_ADMIN' && (
          <button onClick={() => setTab('companysettings')} style={{ fontWeight: tab === 'companysettings' ? 'bold' : 'normal' }}>
            Company Settings
          </button>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 14 }}>
          {user?.email} ({user?.role})
        </span>
        <button onClick={handleLogout}>Log Out</button>
      </nav>
      {tab === 'warehouses' ? (
        <WarehousesPage />
      ) : tab === 'skus' ? (
        <SkusPage />
      ) : tab === 'customers' ? (
        <CustomersPage />
      ) : tab === 'locations' ? (
        <LocationsPage />
      ) : tab === 'gateyard' ? (
        <GateYardPage />
      ) : tab === 'vehicledriver' ? (
        <VehicleDriverPage />
      ) : tab === 'dockdoors' ? (
        <DockDoorsPage />
      ) : tab === 'equipment' ? (
        <EquipmentPage />
      ) : tab === 'putaway' ? (
        <PutawayPage />
      ) : tab === 'insights' ? (
        <InsightsPage />
      ) : tab === 'companysettings' ? (
        <CompanySettingsPage />
      ) : tab === 'inboundorders' ? (
        <InboundOrdersPage />
      ) : (
        <UsersPage />
      )}
    </div>
  );
}

export default App;

import { useState } from 'react';
import WarehousesPage from './WarehousesPage';
import SkusPage from './SkusPage';
import LoginPage from './LoginPage';
import CustomersPage from './CustomersPage';
import UsersPage from './UsersPage';
import LocationsPage from './LocationsPage';
import GateYardPage from './GateYardPage';
import VehicleDriverPage from './VehicleDriverPage';
import CompanySettingsPage from './CompanySettingsPage';

// OPERATOR has zero master-data visibility, including the Users tab itself —
// mirrors UsersController's server-side @Roles() gate (see CLAUDE.md).
// SECURITY_SUPERVISOR (2026-08-27) is included here even though it has no
// access to the other master-data tabs — it's the one exception, needed to
// manage the OPERATOR accounts under it.
const CAN_MANAGE_USERS = ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR', 'SECURITY_SUPERVISOR'];

function App() {
  const [tab, setTab] = useState<'warehouses' | 'skus' | 'customers' | 'users' | 'locations' | 'gateyard' | 'vehicledriver' | 'companysettings'>('warehouses');
  const [user, setUser] = useState<any>(
    localStorage.getItem('user') ? JSON.parse(localStorage.getItem('user')!) : null,
  );

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
  };

  if (!user) {
    return (
      <LoginPage
        onLoginSuccess={() => {
          setUser(JSON.parse(localStorage.getItem('user')!));
        }}
      />
    );
  }

  return (
    <div>
      <nav style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 16, borderBottom: '1px solid #ccc', fontFamily: 'sans-serif' }}>
        <button onClick={() => setTab('warehouses')} style={{ fontWeight: tab === 'warehouses' ? 'bold' : 'normal' }}>
          Warehouses
        </button>
        <button onClick={() => setTab('skus')} style={{ fontWeight: tab === 'skus' ? 'bold' : 'normal' }}>
          SKUs
        </button>
        <button onClick={() => setTab('customers')} style={{ fontWeight: tab === 'customers' ? 'bold' : 'normal' }}>
  Customers
</button>
        <button onClick={() => setTab('locations')} style={{ fontWeight: tab === 'locations' ? 'bold' : 'normal' }}>
          Locations
        </button>
        <button onClick={() => setTab('gateyard')} style={{ fontWeight: tab === 'gateyard' ? 'bold' : 'normal' }}>
          Gate &amp; Yard
        </button>
        <button onClick={() => setTab('vehicledriver')} style={{ fontWeight: tab === 'vehicledriver' ? 'bold' : 'normal' }}>
          Vehicle &amp; Driver Master
        </button>
        {CAN_MANAGE_USERS.includes(user?.role) && (
          <button onClick={() => setTab('users')} style={{ fontWeight: tab === 'users' ? 'bold' : 'normal' }}>
            Users
          </button>
        )}
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
      ) : tab === 'companysettings' ? (
        <CompanySettingsPage />
      ) : (
        <UsersPage />
      )}
    </div>
  );
}

export default App;

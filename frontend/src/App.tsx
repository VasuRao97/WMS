import { useState } from 'react';
import WarehousesPage from './WarehousesPage';
import SkusPage from './SkusPage';
import LoginPage from './LoginPage';
import CustomersPage from './CustomersPage';
import UsersPage from './UsersPage';

// OPERATOR has zero master-data visibility, including the Users tab itself —
// mirrors UsersController's server-side @Roles() gate (see CLAUDE.md).
const CAN_MANAGE_USERS = ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR'];

function App() {
  const [tab, setTab] = useState<'warehouses' | 'skus' | 'customers' | 'users'>('warehouses');
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
        {CAN_MANAGE_USERS.includes(user?.role) && (
          <button onClick={() => setTab('users')} style={{ fontWeight: tab === 'users' ? 'bold' : 'normal' }}>
            Users
          </button>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 14 }}>
          {user?.email} ({user?.role})
        </span>
        <button onClick={handleLogout}>Log Out</button>
      </nav>
      {tab === 'warehouses' ? <WarehousesPage /> : tab === 'skus' ? <SkusPage /> : tab === 'customers' ? <CustomersPage /> : <UsersPage />}
    </div>
  );
}

export default App;

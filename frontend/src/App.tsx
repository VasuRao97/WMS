import { useEffect, useState } from 'react';
import SkusPage from './SkusPage';
import LoginPage from './LoginPage';
import CustomersPage from './CustomersPage';

type Warehouse = {
  id: string;
  code: string;
  name: string;
  address?: string;
};

function authHeaders() {
  const token = localStorage.getItem('token');
  return { Authorization: `Bearer ${token}` };
}

function WarehousesPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');

  const loadWarehouses = () => {
  fetch('http://localhost:3000/warehouses', { headers: authHeaders() })
    .then((res) => {
      if (res.status === 401) {
        localStorage.clear();
        window.location.reload();
        return [];
      }
      return res.json();
    })
    .then((data) => setWarehouses(Array.isArray(data) ? data : []));
};

  useEffect(() => {
    loadWarehouses();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetch('http://localhost:3000/warehouses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ code, name, address }),
    });
    setCode('');
    setName('');
    setAddress('');
    loadWarehouses();
  };

  return (
    <div style={{ maxWidth: 600, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1>Warehouses</h1>
      <form onSubmit={handleSubmit} style={{ marginBottom: 24 }}>
        <input placeholder="Code (e.g. WH1)" value={code} onChange={(e) => setCode(e.target.value)} required style={{ marginRight: 8 }} />
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required style={{ marginRight: 8 }} />
        <input placeholder="Address" value={address} onChange={(e) => setAddress(e.target.value)} style={{ marginRight: 8 }} />
        <button type="submit">Add Warehouse</button>
      </form>
      <ul>
        {warehouses.map((w) => (
          <li key={w.id}>
            <strong>{w.code}</strong> — {w.name} {w.address ? `(${w.address})` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

function App() {
  const [tab, setTab] = useState<'warehouses' | 'skus' | 'customers'>('warehouses');
  const [isLoggedIn, setIsLoggedIn] = useState(!!localStorage.getItem('token'));
  const [user, setUser] = useState<any>(
    localStorage.getItem('user') ? JSON.parse(localStorage.getItem('user')!) : null,
  );

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setIsLoggedIn(false);
    setUser(null);
  };

  if (!isLoggedIn) {
    return (
      <LoginPage
        onLoginSuccess={() => {
          setIsLoggedIn(true);
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
        <span style={{ marginLeft: 'auto', fontSize: 14 }}>
          {user?.email} ({user?.role})
        </span>
        <button onClick={handleLogout}>Log Out</button>
      </nav>
      {tab === 'warehouses' ? <WarehousesPage /> : tab === 'skus' ? <SkusPage /> : <CustomersPage />}
    </div>
  );
}

export default App;
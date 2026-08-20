import { useEffect, useState } from 'react';

type Warehouse = {
  id: string;
  code: string;
  name: string;
  address?: string;
};

function App() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');

  const loadWarehouses = () => {
    fetch('http://localhost:3000/warehouses')
      .then((res) => res.json())
      .then((data) => setWarehouses(data));
  };

  useEffect(() => {
    loadWarehouses();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetch('http://localhost:3000/warehouses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
        <input
          placeholder="Code (e.g. WH1)"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
          style={{ marginRight: 8 }}
        />
        <input
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          style={{ marginRight: 8 }}
        />
        <input
          placeholder="Address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          style={{ marginRight: 8 }}
        />
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

export default App;
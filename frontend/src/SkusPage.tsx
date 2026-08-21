import { useEffect, useState } from 'react';

type StorageUnit = { id: string; unitType: string; qtyInBaseUom: number; isPreferred: boolean };
type Barcode = { id: string; barcode: string; type: string };
type Sku = {
  id: string;
  code: string;
  description: string;
  category: string;
  baseUom: string;
  hsnCode: string;
  storageCondition: string;
  shelfLifeTracked: boolean;
  shelfLifeDays?: number;
  isActive: boolean;
  storageUnits: StorageUnit[];
  barcodes: Barcode[];
};

function SkusPage() {
  const [skus, setSkus] = useState<Sku[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetch('http://localhost:3000/skus')
      .then((res) => res.json())
      .then((data) => setSkus(data));
  }, []);

  const filtered = skus.filter(
    (s) =>
      s.code.toLowerCase().includes(search.toLowerCase()) ||
      s.description.toLowerCase().includes(search.toLowerCase()) ||
      s.category.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div style={{ maxWidth: 900, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1>SKU Master</h1>

      <input
        placeholder="Search by code, description, or category..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ width: '100%', padding: 8, marginBottom: 16, boxSizing: 'border-box' }}
      />

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #ccc' }}>
            <th style={{ padding: 8 }}>Code</th>
            <th style={{ padding: 8 }}>Description</th>
            <th style={{ padding: 8 }}>Category</th>
            <th style={{ padding: 8 }}>Base UOM</th>
            <th style={{ padding: 8 }}>HSN</th>
            <th style={{ padding: 8 }}>Storage</th>
            <th style={{ padding: 8 }}>Shelf Life</th>
            <th style={{ padding: 8 }}>Storage Units</th>
            <th style={{ padding: 8 }}>Barcodes</th>
            <th style={{ padding: 8 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((sku) => (
            <tr key={sku.id} style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: 8, fontWeight: 'bold' }}>{sku.code}</td>
              <td style={{ padding: 8 }}>{sku.description}</td>
              <td style={{ padding: 8 }}>{sku.category}</td>
              <td style={{ padding: 8 }}>{sku.baseUom}</td>
              <td style={{ padding: 8 }}>{sku.hsnCode}</td>
              <td style={{ padding: 8 }}>{sku.storageCondition}</td>
              <td style={{ padding: 8 }}>
                {sku.shelfLifeTracked ? `${sku.shelfLifeDays} days` : '—'}
              </td>
              <td style={{ padding: 8 }}>
                {sku.storageUnits
                  .map((u) => `${u.unitType}=${u.qtyInBaseUom}${u.isPreferred ? ' *' : ''}`)
                  .join(', ')}
              </td>
              <td style={{ padding: 8 }}>
                {sku.barcodes.map((b) => b.barcode).join(', ') || '—'}
              </td>
              <td style={{ padding: 8 }}>{sku.isActive ? 'Active' : 'Inactive'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {filtered.length === 0 && <p style={{ marginTop: 16 }}>No SKUs found.</p>}
    </div>
  );
}

export default SkusPage;
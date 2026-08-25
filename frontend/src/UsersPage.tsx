import { Fragment, useEffect, useState } from 'react';

type WarehouseRef = { id: string; code: string; name: string };

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  isActive: boolean;
  functionTag?: string;
  createdAt: string;
  lastLoginAt?: string | null;
  assignedWarehouses: WarehouseRef[];
};

// Tenure from `createdAt` — no backend field for this, just a day-count.
function daysActive(createdAt: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000));
}

function formatLastLogin(lastLoginAt?: string | null): string {
  if (!lastLoginAt) return 'Never';
  return new Date(lastLoginAt).toLocaleString();
}

// Mirrors UsersService's CREATABLE_ROLES — client-side only for filtering the
// role dropdown to what this caller could plausibly succeed at; the server is
// the real enforcement, this is just UX (don't let someone pick a role their
// role can't create and then get a 403 after filling in the whole form).
const CREATABLE_ROLES: Record<string, string[]> = {
  COMPANY_ADMIN: ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER', 'WAREHOUSE_SUPERVISOR', 'OPERATOR'],
  WAREHOUSE_MANAGER: ['WAREHOUSE_SUPERVISOR', 'OPERATOR'],
  WAREHOUSE_SUPERVISOR: ['OPERATOR'],
  OPERATOR: [],
};

const ROLE_LABELS: Record<string, string> = {
  COMPANY_ADMIN: 'Company Admin',
  WAREHOUSE_MANAGER: 'Warehouse Manager',
  WAREHOUSE_SUPERVISOR: 'Warehouse Supervisor',
  OPERATOR: 'Operator',
};

const EMAIL_REQUIRED_ROLES = ['COMPANY_ADMIN', 'WAREHOUSE_MANAGER'];

function authHeaders() {
  const token = localStorage.getItem('token');
  return { Authorization: `Bearer ${token}` };
}

function currentUser(): any {
  return localStorage.getItem('user') ? JSON.parse(localStorage.getItem('user')!) : null;
}

const emptyForm = {
  name: '',
  email: '',
  password: '',
  role: '',
  functionTag: '',
  assignedWarehouseIds: [] as string[],
};

function UsersPage() {
  const me = currentUser();
  const creatableRoles = CREATABLE_ROLES[me?.role] || [];

  const [users, setUsers] = useState<UserRow[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseRef[]>([]);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState('');
  // Warehouses this edit's subject is assigned to that fall outside the
  // current viewer's own scope (e.g. a Supervisor shared with another
  // Manager's warehouse) — shown so it's clear they exist, kept untouched by
  // this edit rather than silently dropped or blocking the save entirely.
  const [hiddenWarehouseCount, setHiddenWarehouseCount] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const [loginHistory, setLoginHistory] = useState<{ id: string; loggedInAt: string }[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const loadUsers = () => {
    fetch('http://localhost:3000/users', { headers: authHeaders() })
      .then((res) => {
        if (res.status === 401) {
          localStorage.clear();
          window.location.reload();
          return [];
        }
        return res.json();
      })
      .then((data) => setUsers(Array.isArray(data) ? data : []));
  };

  const loadWarehouses = () => {
    fetch('http://localhost:3000/warehouses', { headers: authHeaders() })
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setWarehouses(Array.isArray(data) ? data : []));
  };

  useEffect(() => {
    loadUsers();
    loadWarehouses();
  }, []);

  const resetForm = () => {
    setForm(emptyForm);
    setEditingId(null);
    setHiddenWarehouseCount(0);
    setFormError('');
  };

  const startEdit = (u: UserRow) => {
    // Only pre-fill warehouse ids this viewer can actually see/control in the
    // picker below — an id outside that set (a warehouse shared with another
    // Manager) must never round-trip through this form's submit, or the
    // server would either reject the whole save or (if it didn't know better)
    // silently strip that other assignment. The server independently
    // preserves anything outside this viewer's scope regardless.
    const visibleIds = new Set(warehouses.map((w) => w.id));
    const editableAssigned = u.assignedWarehouses.filter((w) => visibleIds.has(w.id)).map((w) => w.id);
    setHiddenWarehouseCount(u.assignedWarehouses.length - editableAssigned.length);

    setEditingId(u.id);
    setForm({
      name: u.name,
      email: u.email,
      password: '',
      role: u.role,
      functionTag: u.functionTag || '',
      assignedWarehouseIds: editableAssigned,
    });
    setFormError('');
    setShowForm(true);
  };

  const toggleWarehouse = (id: string) => {
    setForm((f) => ({
      ...f,
      assignedWarehouseIds: f.assignedWarehouseIds.includes(id)
        ? f.assignedWarehouseIds.filter((w) => w !== id)
        : [...f.assignedWarehouseIds, id],
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    const body: any = {
      name: form.name,
      email: form.email,
      role: form.role,
      functionTag: form.functionTag || undefined,
      assignedWarehouseIds: form.assignedWarehouseIds,
    };
    // Password required on create; on edit, blank means "leave unchanged".
    if (!editingId || form.password) body.password = form.password;

    const url = editingId ? `http://localhost:3000/users/${editingId}` : 'http://localhost:3000/users';
    const method = editingId ? 'PATCH' : 'POST';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      setFormError(Array.isArray(data.message) ? data.message.join(' | ') : data.message);
      return;
    }
    resetForm();
    loadUsers();
  };

  const handleDeactivate = async (id: string, isActive: boolean) => {
    const action = isActive ? 'deactivate' : 'reactivate';
    await fetch(`http://localhost:3000/users/${id}/${action}`, { method: 'PATCH', headers: authHeaders() });
    loadUsers();
  };

  const toggleHistory = async (u: UserRow) => {
    if (expandedHistoryId === u.id) {
      setExpandedHistoryId(null);
      return;
    }
    setExpandedHistoryId(u.id);
    setHistoryLoading(true);
    const res = await fetch(`http://localhost:3000/users/${u.id}/login-history`, { headers: authHeaders() });
    const data = await res.json();
    setLoginHistory(Array.isArray(data) ? data : []);
    setHistoryLoading(false);
  };

  const handleImport = async () => {
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('http://localhost:3000/users/import', { method: 'POST', headers: authHeaders(), body: formData });
    const data = await res.json();
    setImportResult(data);
    setImporting(false);
    setFile(null);
    loadUsers();
  };

  const handleExport = () => {
    fetch('http://localhost:3000/users/export', { headers: authHeaders() })
      .then((res) => res.blob())
      .then((blob) => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'User_Master_Export.xlsx';
        a.click();
        window.URL.revokeObjectURL(url);
      });
  };

  const emailRequired = EMAIL_REQUIRED_ROLES.includes(form.role);
  const warehousesRequired = form.role && form.role !== 'COMPANY_ADMIN';
  const isSelfEdit = !!editingId && editingId === me?.id;

  const filtered = users.filter(
    (u) =>
      u.name.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase()) ||
      (u.functionTag || '').toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div style={{ maxWidth: 1050, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1>User Master</h1>

      {creatableRoles.length === 0 ? (
        <p style={{ color: '#888' }}>Your role cannot create or manage other users.</p>
      ) : (
        <>
          <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
            <h3 style={{ marginTop: 0 }}>Import from Excel</h3>
            <p style={{ marginTop: -4, marginBottom: 12, fontSize: 12, color: '#888' }}>
              For onboarding many users at once (e.g. a batch of Operators) — same rules apply as adding one by hand:
              you can only import roles you're allowed to create, into warehouses you yourself have access to.
              Columns: Name, Login ID, Password, Role, Function Tag, Warehouse Code(s) (comma-separated).
            </p>
            <input type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files ? e.target.files[0] : null)} />
            <button onClick={handleImport} disabled={!file || importing} style={{ marginLeft: 8 }}>
              {importing ? 'Importing...' : 'Import'}
            </button>
            <button onClick={handleExport} style={{ marginLeft: 8 }}>Export to Excel</button>
            {importResult && (
              <div style={{ marginTop: 16 }}>
                <p>
                  <strong>{importResult.successCount}</strong> succeeded, <strong>{importResult.failCount}</strong> failed,
                  out of {importResult.totalUsers} users.
                </p>
                <ul style={{ maxHeight: 200, overflowY: 'auto' }}>
                  {importResult.results?.map((r: any, i: number) => (
                    <li key={i} style={{ color: r.status === 'error' ? 'crimson' : 'green' }}>
                      {r.email}: {r.status === 'success' ? 'Imported' : r.errors?.join('; ')}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div style={{ marginBottom: 24 }}>
            <button type="button" onClick={() => (showForm ? resetForm() : setShowForm(true))}>
              {showForm ? '▾ Hide' : '▸ Add User manually'}
            </button>
          </div>
        </>
      )}

      {showForm && (
        <div style={{ marginBottom: 24, padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>{editingId ? 'Edit User' : 'Add User'}</h3>
          <p style={{ marginTop: -4, marginBottom: 12, fontSize: 12, color: '#888' }}>* required</p>
          <form onSubmit={handleSubmit}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <input
                placeholder="Name *"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                style={{ width: 180 }}
              />
              <input
                placeholder={emailRequired ? 'Email *' : 'Login ID *'}
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
                disabled={!!editingId}
                title={editingId ? "Login ID can't be changed after creation" : undefined}
                style={{ width: 200, background: editingId ? '#f0f0f0' : 'white' }}
              />
              <input
                placeholder={editingId ? 'New Password (leave blank to keep)' : 'Password *'}
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                required={!editingId}
                style={{ width: 200 }}
              />
              <select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                required
                disabled={isSelfEdit}
                title={isSelfEdit ? "You can't change your own role" : undefined}
                style={{ width: 180, background: isSelfEdit ? '#f0f0f0' : 'white' }}
              >
                <option value="">Role *</option>
                {creatableRoles.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
                {isSelfEdit && !creatableRoles.includes(form.role) && (
                  <option value={form.role}>{ROLE_LABELS[form.role] || form.role}</option>
                )}
              </select>
              <input
                placeholder="Function Tag (e.g. Inbound Sup, Picking)"
                value={form.functionTag}
                onChange={(e) => setForm({ ...form, functionTag: e.target.value })}
                style={{ width: 220 }}
              />
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 13, color: '#555', marginBottom: 4 }}>
                Assigned Warehouses{warehousesRequired ? ' *' : ''}
                {warehouses.length === 0 && (
                  <span style={{ color: '#888' }}> — none available to assign in your scope.</span>
                )}
                {hiddenWarehouseCount > 0 && (
                  <span style={{ color: '#888' }}>
                    {' '}
                    — also assigned to {hiddenWarehouseCount} warehouse{hiddenWarehouseCount > 1 ? 's' : ''} outside
                    your access (unchanged by this edit).
                  </span>
                )}
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxWidth: 600 }}>
                {warehouses.map((w) => (
                  <label
                    key={w.id}
                    style={{
                      border: '1px solid #ccc',
                      borderRadius: 4,
                      padding: '4px 8px',
                      fontSize: 13,
                      background: form.assignedWarehouseIds.includes(w.id) ? '#e6f0ff' : 'white',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={form.assignedWarehouseIds.includes(w.id)}
                      onChange={() => toggleWarehouse(w.id)}
                      style={{ marginRight: 4 }}
                    />
                    {w.code} — {w.name}
                  </label>
                ))}
              </div>
            </div>

            {formError && <p style={{ color: 'crimson' }}>{formError}</p>}
            <div>
              <button type="submit">{editingId ? 'Save Changes' : 'Add User'}</button>
              {editingId && (
                <button type="button" onClick={resetForm} style={{ marginLeft: 8 }}>
                  Cancel
                </button>
              )}
            </div>
          </form>
        </div>
      )}

      <input
        placeholder="Search by name, login ID, or function tag..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ width: '100%', padding: 8, marginBottom: 16, boxSizing: 'border-box' }}
      />

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #ccc' }}>
            <th style={{ padding: 8 }}>Name</th>
            <th style={{ padding: 8 }}>Login ID</th>
            <th style={{ padding: 8 }}>Role</th>
            <th style={{ padding: 8 }}>Function Tag</th>
            <th style={{ padding: 8 }}>Assigned Warehouses</th>
            <th style={{ padding: 8 }}>Days Active</th>
            <th style={{ padding: 8 }}>Last Login</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((u) => (
            <Fragment key={u.id}>
              <tr style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: 8, fontWeight: 'bold' }}>{u.name}</td>
                <td style={{ padding: 8 }}>{u.email}</td>
                <td style={{ padding: 8 }}>{ROLE_LABELS[u.role] || u.role}</td>
                <td style={{ padding: 8 }}>{u.functionTag || '—'}</td>
                <td style={{ padding: 8 }}>
                  {u.assignedWarehouses.length > 0 ? u.assignedWarehouses.map((w) => w.code).join(', ') : '—'}
                </td>
                <td style={{ padding: 8 }}>{daysActive(u.createdAt)}</td>
                <td style={{ padding: 8 }}>
                  <button onClick={() => toggleHistory(u)} style={{ fontSize: 13 }}>
                    {formatLastLogin(u.lastLoginAt)} {expandedHistoryId === u.id ? '▲' : '▼'}
                  </button>
                </td>
                <td style={{ padding: 8 }}>{u.isActive ? 'Active' : 'Inactive'}</td>
                <td style={{ padding: 8, whiteSpace: 'nowrap' }}>
                  <button onClick={() => startEdit(u)}>Edit</button>
                  <button onClick={() => handleDeactivate(u.id, u.isActive)} style={{ marginLeft: 6 }}>
                    {u.isActive ? 'Deactivate' : 'Reactivate'}
                  </button>
                </td>
              </tr>
              {expandedHistoryId === u.id && (
                <tr>
                  <td colSpan={9} style={{ padding: 12, background: '#fafafa' }}>
                    <strong style={{ fontSize: 13 }}>Login history</strong>{' '}
                    <span style={{ fontSize: 12, color: '#888' }}>(most recent 100)</span>
                    {historyLoading ? (
                      <p style={{ margin: '8px 0 0' }}>Loading...</p>
                    ) : loginHistory.length === 0 ? (
                      <p style={{ margin: '8px 0 0' }}>
                        <em>No logins recorded yet.</em>
                      </p>
                    ) : (
                      <ul style={{ margin: '8px 0 0', maxHeight: 220, overflowY: 'auto', fontSize: 13 }}>
                        {loginHistory.map((h) => (
                          <li key={h.id}>{new Date(h.loggedInAt).toLocaleString()}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>

      {filtered.length === 0 && <p style={{ marginTop: 16 }}>No users found.</p>}
    </div>
  );
}

export default UsersPage;

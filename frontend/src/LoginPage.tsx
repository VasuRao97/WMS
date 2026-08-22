import { useState } from 'react';

type Props = {
  onLoginSuccess: () => void;
};

function LoginPage({ onLoginSuccess }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [companyCode, setCompanyCode] = useState('');
  const [adminName, setAdminName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const res = await fetch('http://localhost:3000/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.message || 'Login failed.');
      return;
    }
    localStorage.setItem('token', data.accessToken);
    localStorage.setItem('user', JSON.stringify(data.user));
    onLoginSuccess();
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const res = await fetch('http://localhost:3000/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyName, companyCode, adminName, email, password }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(Array.isArray(data.message) ? data.message.join(', ') : data.message || 'Registration failed.');
      return;
    }
    localStorage.setItem('token', data.accessToken);
    localStorage.setItem('user', JSON.stringify(data.user));
    onLoginSuccess();
  };

  return (
    <div style={{ maxWidth: 400, margin: '80px auto', fontFamily: 'sans-serif' }}>
      <h1>{mode === 'login' ? 'Log In' : 'Register Your Company'}</h1>

      <form onSubmit={mode === 'login' ? handleLogin : handleRegister}>
        {mode === 'register' && (
          <>
            <input placeholder="Company Name" value={companyName} onChange={(e) => setCompanyName(e.target.value)} required style={inputStyle} />
            <input placeholder="Company Code (e.g. TESTCO)" value={companyCode} onChange={(e) => setCompanyCode(e.target.value)} required style={inputStyle} />
            <input placeholder="Your Name" value={adminName} onChange={(e) => setAdminName(e.target.value)} required style={inputStyle} />
          </>
        )}
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required style={inputStyle} />
        <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required style={inputStyle} />

        {error && <p style={{ color: 'crimson' }}>{error}</p>}

        <button type="submit" disabled={loading} style={{ width: '100%', padding: 10, marginTop: 8 }}>
          {loading ? 'Please wait...' : mode === 'login' ? 'Log In' : 'Register'}
        </button>
      </form>

      <p style={{ marginTop: 16, textAlign: 'center' }}>
        {mode === 'login' ? (
          <>New company? <a href="#" onClick={() => setMode('register')}>Register here</a></>
        ) : (
          <>Already have an account? <a href="#" onClick={() => setMode('login')}>Log in</a></>
        )}
      </p>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: 8,
  marginBottom: 10,
  boxSizing: 'border-box',
};

export default LoginPage;
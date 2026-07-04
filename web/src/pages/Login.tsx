import { useState } from 'react';
import { api, setToken } from '../api';

export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = mode === 'login' ? await api.login(email, password) : await api.register(email, password);
      setToken(r.token);
      onAuthed();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth__card">
        <div className="auth__brand">sched<b>·</b>ctl</div>
        <div className="auth__tag">Distributed job scheduler — operations console</div>
        <div className="panel">
          <div className="panel__body">
            <div className="tabs" style={{ marginBottom: 18 }}>
              <button type="button" className={`tab${mode === 'login' ? ' active' : ''}`} onClick={() => setMode('login')}>Sign in</button>
              <button type="button" className={`tab${mode === 'register' ? ' active' : ''}`} onClick={() => setMode('register')}>Register</button>
            </div>
            <form onSubmit={submit}>
              <label className="field"><span>Email</span>
                <input type="email" autoComplete="username" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} required />
              </label>
              <label className="field"><span>Password <span className="dim">(min 6)</span></span>
                <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
              </label>
              <div className="err" aria-live="polite">{err}</div>
              <button className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} disabled={busy}>
                {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

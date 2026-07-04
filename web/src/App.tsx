import { useState, type ReactNode } from 'react';
import { NavLink, Route, Routes, Navigate } from 'react-router-dom';
import { getToken, clearToken } from './api';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Queues } from './pages/Queues';
import { QueueDetail } from './pages/QueueDetail';
import { Workers } from './pages/Workers';
import { JobDetail } from './pages/JobDetail';

export function App() {
  const [authed, setAuthed] = useState(!!getToken());
  if (!authed) return <Login onAuthed={() => setAuthed(true)} />;

  const logout = () => { clearToken(); setAuthed(false); };
  return (
    <div className="app">
      <nav className="rail">
        <div className="brand">
          <span className="brand__mark">sched<b>·</b>ctl</span>
        </div>
        <NavLink to="/" end className="rail__link"><span className="dot" aria-hidden="true" />Overview</NavLink>
        <NavLink to="/queues" className="rail__link"><span className="dot" aria-hidden="true" />Queues</NavLink>
        <NavLink to="/workers" className="rail__link"><span className="dot" aria-hidden="true" />Workers</NavLink>
        <div className="rail__foot">
          <button className="btn btn--ghost btn--sm" style={{ width: '100%' }} onClick={logout}>Sign out</button>
        </div>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/queues" element={<Queues />} />
          <Route path="/queues/:id" element={<QueueDetail />} />
          <Route path="/workers" element={<Workers />} />
          <Route path="/jobs/:id" element={<JobDetail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export function Page({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className="topbar">
        <h1>{title}</h1>
        <div className="topbar__meta">
          {action}
          <span className="pulse"><i aria-hidden="true" />live</span>
        </div>
      </div>
      <div className="content">{children}</div>
    </>
  );
}

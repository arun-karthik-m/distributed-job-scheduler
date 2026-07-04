import type { ReactNode } from 'react';

export const STATE_ORDER = ['SCHEDULED', 'QUEUED', 'CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED', 'DLQ'] as const;
export const STATE_COLOR: Record<string, string> = {
  SCHEDULED: 'var(--s-scheduled)', QUEUED: 'var(--s-queued)', CLAIMED: 'var(--s-claimed)',
  RUNNING: 'var(--s-running)', COMPLETED: 'var(--s-completed)', FAILED: 'var(--s-failed)', DLQ: 'var(--s-dlq)',
};

export function StatePill({ status }: { status: string }) {
  return <span className={`pill pill--${status}`}>{status.toLowerCase()}</span>;
}

// SIGNATURE: the job lifecycle rendered as a proportional bar — color encodes state, width encodes
// how much of the system is in it. One glance = system health.
export function StateTrack({ stats }: { stats: Record<string, number> }) {
  const entries = STATE_ORDER.map((s) => [s, stats[s] ?? 0] as const).filter(([, n]) => n > 0);
  const total = entries.reduce((a, [, n]) => a + n, 0) || 1;
  return (
    <div>
      <div className="track">
        {entries.length === 0
          ? <div className="track__seg" style={{ flex: 1, background: 'var(--line-soft)' }} />
          : entries.map(([s, n]) => (
              <div key={s} className="track__seg" style={{ flex: n, background: STATE_COLOR[s] }} title={`${s}: ${n}`}>
                {n / total > 0.06 && <span>{n}</span>}
              </div>
            ))}
      </div>
      <div className="track__legend">
        {STATE_ORDER.map((s) => (
          <div key={s} className="track__key">
            <i style={{ background: STATE_COLOR[s] }} />{s.toLowerCase()}
            <b style={{ color: 'var(--ink)' }}>{stats[s] ?? 0}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

// per-job lifecycle position
const LIFE = ['QUEUED', 'CLAIMED', 'RUNNING', 'COMPLETED'];
export function LifeTrack({ status }: { status: string }) {
  const terminal = status === 'FAILED' || status === 'DLQ';
  const path = terminal ? ['QUEUED', 'CLAIMED', 'RUNNING', status] : LIFE;
  const reached = terminal ? path.length - 1 : LIFE.indexOf(status);
  const color = STATE_COLOR[status] ?? 'var(--s-queued)';
  return (
    <div className="life" style={{ color }}>
      {path.map((n, i) => (
        <span key={n} className="life__node">
          {i > 0 && <span className={`life__bar${i <= reached ? ' on' : ''}`} />}
          <span className={`life__dot${i <= reached ? ' on' : ''}`} title={n} />
        </span>
      ))}
      <span className="life__label">{status.toLowerCase()}</span>
    </div>
  );
}

export function Sparkline({ points, height = 60 }: { points: number[]; height?: number }) {
  if (points.length === 0) return <div className="empty">no completions in the last 30 min</div>;
  const w = 100;
  const max = Math.max(...points, 1);
  const step = points.length > 1 ? w / (points.length - 1) : w;
  const pts = points.map((p, i) => `${i * step},${height - (p / max) * (height - 10) - 5}`);
  const line = 'M' + pts.join(' L');
  const area = `M0,${height} L` + pts.join(' L') + ` L${(points.length - 1) * step},${height} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }} role="img" aria-label="completion throughput, last 30 minutes">
      <defs>
        <linearGradient id="sg" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.35" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#sg)" />
      <path d={line} fill="none" stroke="var(--accent-2)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Stat({ label, value, foot, accent }: { label: string; value: ReactNode; foot?: ReactNode; accent?: boolean }) {
  return (
    <div className={`panel stat${accent ? ' stat--accent' : ''}`}>
      <div className="stat__label">{label}</div>
      <div className="stat__num">{value}</div>
      {foot && <div className="stat__foot">{foot}</div>}
    </div>
  );
}

export function Panel({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="panel">
      {(title || action) && (
        <div className="panel__head"><h2>{title}</h2>{action}</div>
      )}
      <div className="panel__body">{children}</div>
    </div>
  );
}

export function ago(iso: string | null): string {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) return 'in ' + ago(new Date(Date.now() - s * 2000).toISOString()).replace(' ago', '');
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

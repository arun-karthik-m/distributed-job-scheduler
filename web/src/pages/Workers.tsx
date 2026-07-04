import { usePoll } from '../hooks';
import { api } from '../api';
import { Page } from '../App';
import { ago } from '../components';

export function Workers() {
  const { data } = usePoll(() => api.workers(), [], 3000);
  const workers = data?.data ?? [];
  const live = workers.filter((w) => w.live).length;

  return (
    <Page title="Workers" action={<span className="eyebrow">{live} live · {workers.length} known</span>}>
      <div className="panel">
        {workers.length === 0
          ? <div className="empty">no workers have registered — start one with <span className="kbd">npm run worker</span></div>
          : (
            <table className="data">
              <thead><tr><th>Worker</th><th>Name</th><th>Liveness</th><th>Last heartbeat</th><th>Uptime since</th></tr></thead>
              <tbody>
                {workers.map((w) => (
                  <tr key={w.id}>
                    <td className="num">#{w.id}</td>
                    <td>{w.name}</td>
                    <td>
                      <span className="row gap-sm">
                        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: w.live ? 'var(--s-running)' : 'var(--ink-dim)', boxShadow: w.live ? '0 0 8px var(--s-running)' : 'none' }} />
                        <span className="mono" style={{ fontSize: 12, color: w.live ? 'var(--ink)' : 'var(--ink-dim)' }}>{w.live ? 'alive' : w.status === 'alive' ? 'stale' : w.status}</span>
                      </span>
                    </td>
                    <td className="num">{ago(w.last_seen)}</td>
                    <td className="num">{ago(w.started_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </Page>
  );
}

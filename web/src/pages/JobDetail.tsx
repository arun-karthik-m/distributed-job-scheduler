import { Link, useParams } from 'react-router-dom';
import { usePoll } from '../hooks';
import { api } from '../api';
import { Page } from '../App';
import { Panel, StatePill, LifeTrack, ago } from '../components';

interface Execution { attempt: number; worker_id: number | null; status: string; started_at: string; finished_at: string | null; error: string | null; }
interface LogLine { ts: string; level: string; message: string; }

export function JobDetail() {
  const { id } = useParams();
  const jobId = Number(id);
  const { data: job, refresh } = usePoll(() => api.job(jobId), [jobId], 3000);

  if (!job) return <Page title="Job"><div className="empty">loading…</div></Page>;
  const retryable = job.status === 'FAILED' || job.status === 'DLQ';
  const execs: Execution[] = job.executions ?? [];
  const logs: LogLine[] = job.logs ?? [];

  const meta: [string, React.ReactNode][] = [
    ['type', job.type],
    ['priority', job.priority],
    ['attempts', `${job.attempts} / ${job.max_attempts}`],
    ['queue', <Link className="rowlink" to={`/queues/${job.queue_id}`}>#{job.queue_id}</Link>],
    ['lease token', job.lease_token],
    ['worker', job.worker_id ? `#${job.worker_id}` : '—'],
    ['created', ago(job.created_at)],
    ['run at', new Date(job.run_at).toLocaleString()],
    ['completed', job.completed_at ? ago(job.completed_at) : '—'],
    ['idempotency key', job.idempotency_key ?? '—'],
  ];

  return (
    <Page title={`Job #${job.id}`}
      action={retryable ? <button className="btn btn--sm" onClick={async () => { await api.retryJob(jobId); refresh(); }}>Retry</button> : undefined}>
      <div className="row" style={{ marginBottom: 16, marginTop: -8 }}>
        <Link className="rowlink" to={`/queues/${job.queue_id}`}>← queue #{job.queue_id}</Link>
        <span className="dim">/</span><StatePill status={job.status} />
      </div>

      <Panel title="Lifecycle">
        <LifeTrack status={job.status} />
      </Panel>

      <div className="grid cols-2 mt">
        <Panel title="Details">
          <table className="data">
            <tbody>
              {meta.map(([k, v]) => (
                <tr key={k}><td className="dim" style={{ width: 150 }}>{k}</td><td className="mono" style={{ fontSize: 12 }}>{v}</td></tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Payload">
          <pre className="mono" style={{ margin: 0, fontSize: 12, color: 'var(--ink-mut)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {JSON.stringify(job.payload, null, 2)}
          </pre>
        </Panel>
      </div>

      <div className="mt-lg">
        <div className="eyebrow" style={{ marginBottom: 10 }}>execution history · {execs.length} attempt{execs.length === 1 ? '' : 's'}</div>
        <div className="panel">
          {execs.length === 0
            ? <div className="empty">not yet executed</div>
            : (
              <table className="data">
                <thead><tr><th>#</th><th>Worker</th><th>Status</th><th>Started</th><th>Finished</th><th>Error</th></tr></thead>
                <tbody>
                  {execs.map((e) => (
                    <tr key={e.attempt}>
                      <td className="num">{e.attempt}</td>
                      <td className="num">{e.worker_id ? `#${e.worker_id}` : '—'}</td>
                      <td><StatePill status={e.status} /></td>
                      <td className="num">{ago(e.started_at)}</td>
                      <td className="num">{e.finished_at ? ago(e.finished_at) : '—'}</td>
                      <td className="muted" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: e.error ? 'var(--s-failed)' : 'var(--ink-dim)' }}>{e.error ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      </div>

      <div className="mt-lg">
        <div className="eyebrow" style={{ marginBottom: 10 }}>execution log</div>
        <div className="panel">
          {logs.length === 0
            ? <div className="empty">no log lines yet</div>
            : (
              <div style={{ padding: '10px 16px', fontFamily: 'var(--mono)', fontSize: 12 }}>
                {logs.map((l, i) => (
                  <div key={i} style={{ display: 'flex', gap: 14, padding: '3px 0', color: l.level === 'error' ? 'var(--s-failed)' : 'var(--ink-mut)' }}>
                    <span className="dim" style={{ minWidth: 78 }}>{new Date(l.ts).toLocaleTimeString()}</span>
                    <span style={{ minWidth: 40, color: l.level === 'error' ? 'var(--s-dlq)' : 'var(--ink-dim)' }}>{l.level}</span>
                    <span>{l.message}</span>
                  </div>
                ))}
              </div>
            )}
        </div>
      </div>
    </Page>
  );
}

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { usePoll } from '../hooks';
import { api } from '../api';
import { Page } from '../App';
import { Panel, StatePill, StateTrack, STATE_ORDER, ago } from '../components';

export function QueueDetail() {
  const { id } = useParams();
  const queueId = Number(id);
  const [tab, setTab] = useState<'jobs' | 'dlq'>('jobs');
  const [filter, setFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const limit = 20;

  const { data: queue, refresh: refreshQ } = usePoll(() => api.queue(queueId), [queueId], 4000);
  const { data: stats } = usePoll(() => api.queueStats(queueId), [queueId], 3000);
  const { data: jobs, refresh: refreshJobs } = usePoll(
    () => api.jobs(queueId, { status: filter || undefined, limit, offset }), [queueId, filter, offset], 3000);
  const { data: dlq, refresh: refreshDlq } = usePoll(() => api.dlq(queueId), [queueId], 4000);

  if (!queue) return <Page title="Queue"><div className="empty">loading…</div></Page>;

  const paused = queue.status === 'paused';
  const refreshAll = () => { refreshQ(); refreshJobs(); refreshDlq(); };

  return (
    <Page title={queue.name}
      action={
        <button className={`btn btn--sm ${paused ? '' : 'btn--ghost'}`} onClick={async () => { await api.patchQueue(queueId, { status: paused ? 'active' : 'paused' }); refreshQ(); }}>
          {paused ? 'Resume queue' : 'Pause queue'}
        </button>
      }>
      <div className="row" style={{ marginBottom: 16, marginTop: -8 }}>
        <Link className="rowlink" to="/queues">← queues</Link>
        <span className="dim">/</span><StatePill status={paused ? 'paused' : 'active'} />
        <span className="dim mono" style={{ fontSize: 12 }}>queue #{queue.id}</span>
      </div>

      <Panel title="State" action={<span className="eyebrow">lifecycle</span>}>
        <StateTrack stats={stats?.stats ?? {}} />
      </Panel>

      <div className="grid cols-2 mt">
        <QueueConfig queue={queue} onSaved={refreshQ} />
        <CreateJob queueId={queueId} onCreated={refreshAll} />
      </div>

      <div className="between mt-lg" style={{ marginBottom: 12 }}>
        <div className="tabs">
          <button type="button" className={`tab${tab === 'jobs' ? ' active' : ''}`} onClick={() => setTab('jobs')}>Job explorer</button>
          <button type="button" className={`tab${tab === 'dlq' ? ' active' : ''}`} onClick={() => setTab('dlq')}>Dead letter ({dlq?.data.length ?? 0})</button>
        </div>
        {tab === 'jobs' && (
          <div className="inline-form">
            <select aria-label="filter by status" value={filter} onChange={(e) => { setFilter(e.target.value); setOffset(0); }}>
              <option value="">all states</option>
              {STATE_ORDER.map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
            </select>
          </div>
        )}
      </div>

      {tab === 'jobs' ? (
        <div className="panel">
          {!jobs || jobs.data.length === 0
            ? <div className="empty">no jobs{filter ? ` in ${filter.toLowerCase()}` : ''}</div>
            : (
              <table className="data">
                <thead><tr><th>Job</th><th>Type</th><th>Status</th><th>Attempts</th><th>Run at</th><th>Created</th></tr></thead>
                <tbody>
                  {jobs.data.map((j) => (
                    <tr key={j.id}>
                      <td><Link className="rowlink" to={`/jobs/${j.id}`}>#{j.id}</Link></td>
                      <td className="num">{j.type}</td>
                      <td><StatePill status={j.status} /></td>
                      <td className="num">{j.attempts}</td>
                      <td className="num">{new Date(j.run_at).toLocaleTimeString()}</td>
                      <td className="num">{ago(j.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          <div className="between" style={{ padding: '12px 14px', borderTop: '1px solid var(--line-soft)' }}>
            <span className="dim mono" style={{ fontSize: 11 }}>offset {offset}</span>
            <div className="row gap-sm">
              <button className="btn btn--ghost btn--sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Prev</button>
              <button className="btn btn--ghost btn--sm" disabled={(jobs?.data.length ?? 0) < limit} onClick={() => setOffset(offset + limit)}>Next</button>
            </div>
          </div>
        </div>
      ) : (
        <div className="panel">
          {!dlq || dlq.data.length === 0
            ? <div className="empty">dead-letter queue is empty — nothing has permanently failed</div>
            : (
              <table className="data">
                <thead><tr><th>Job</th><th>Reason</th><th>Attempts</th><th>Failed</th><th className="right">Action</th></tr></thead>
                <tbody>
                  {dlq.data.map((d) => (
                    <tr key={d.id}>
                      <td><Link className="rowlink" to={`/jobs/${d.job_id}`}>#{d.job_id}</Link></td>
                      <td className="muted" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.reason}</td>
                      <td className="num">{d.attempts}</td>
                      <td className="num">{ago(d.failed_at)}</td>
                      <td className="right"><button className="btn btn--ghost btn--sm" onClick={async () => { await api.retryJob(d.job_id); refreshAll(); }}>Requeue</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      )}
    </Page>
  );
}

function QueueConfig({ queue, onSaved }: { queue: { id: number; priority: number; concurrency_limit: number }; onSaved: () => void }) {
  const [priority, setPriority] = useState(queue.priority);
  const [limit, setLimit] = useState(queue.concurrency_limit);
  const [saved, setSaved] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    await api.patchQueue(queue.id, { priority, concurrency_limit: limit });
    setSaved(true); setTimeout(() => setSaved(false), 1500);
    onSaved();
  }
  return (
    <Panel title="Configuration">
      <form onSubmit={save}>
        <div className="grid cols-2">
          <label className="field"><span>Priority</span>
            <input type="number" value={priority} onChange={(e) => setPriority(Number(e.target.value))} />
          </label>
          <label className="field"><span>Concurrency limit</span>
            <input type="number" min={1} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
          </label>
        </div>
        <div className="row">
          <button className="btn">Save</button>
          {saved && <span className="mono" style={{ fontSize: 12, color: 'var(--s-completed)' }}>saved ✓</span>}
        </div>
      </form>
    </Panel>
  );
}

function CreateJob({ queueId, onCreated }: { queueId: number; onCreated: () => void }) {
  const [type, setType] = useState('immediate');
  const [arg, setArg] = useState('');
  const [payload, setPayload] = useState('');
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    let body: Record<string, unknown> = { type };
    if (payload.trim()) {
      try { body.payload = JSON.parse(payload); } catch { setErr('payload must be valid JSON'); return; }
    }
    if (type === 'delayed') body.delaySeconds = Number(arg) || 0;
    if (type === 'scheduled') body.runAt = arg || new Date(Date.now() + 60000).toISOString();
    if (type === 'recurring') body.cron = arg || '* * * * *';
    if (type === 'batch') body.payloads = Array.from({ length: Number(arg) || 3 }, (_, i) => ({ i }));
    try { await api.createJob(queueId, body); setArg(''); setPayload(''); onCreated(); }
    catch (e) { setErr((e as Error).message); }
  }

  const argHint: Record<string, string> = {
    delayed: 'delay seconds', scheduled: 'ISO run-at', recurring: 'cron expr', batch: 'count',
  };

  return (
    <Panel title="Enqueue job">
      <form onSubmit={submit}>
        <div className="inline-form" style={{ marginBottom: 12 }}>
          <select aria-label="job type" value={type} onChange={(e) => setType(e.target.value)}>
            {['immediate', 'delayed', 'scheduled', 'recurring', 'batch'].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          {type !== 'immediate' && (
            <input aria-label={argHint[type]} placeholder={argHint[type]} value={arg} onChange={(e) => setArg(e.target.value)} style={{ flex: 1 }} />
          )}
          <button className="btn">Enqueue</button>
        </div>
        <input aria-label="payload JSON" placeholder='payload JSON (optional) e.g. {"to":"x"}' value={payload} onChange={(e) => setPayload(e.target.value)} />
        {err && <div className="err" aria-live="polite">{err}</div>}
      </form>
    </Panel>
  );
}

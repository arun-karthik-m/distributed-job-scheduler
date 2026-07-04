import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePoll } from '../hooks';
import { api, type Queue } from '../api';
import { Page } from '../App';
import { Panel, StatePill } from '../components';

interface ProjWithQueues { id: number; name: string; queues: Queue[]; }

async function loadAll(): Promise<ProjWithQueues[]> {
  const { data: projects } = await api.projects();
  return Promise.all(projects.map(async (p) => ({ id: p.id, name: p.name, queues: (await api.queues(p.id)).data })));
}

export function Queues() {
  const { data, refresh } = usePoll(loadAll, [], 4000);
  const [projName, setProjName] = useState('');
  const [q, setQ] = useState({ projectId: 0, name: '', concurrency_limit: 10 });

  const projects = data ?? [];

  async function addProject(e: React.FormEvent) {
    e.preventDefault();
    if (!projName.trim()) return;
    await api.createProject(projName.trim());
    setProjName('');
    refresh();
  }
  async function addQueue(e: React.FormEvent) {
    e.preventDefault();
    const pid = q.projectId || projects[0]?.id;
    if (!pid || !q.name.trim()) return;
    await api.createQueue(pid, { name: q.name.trim(), concurrency_limit: q.concurrency_limit });
    setQ({ projectId: pid, name: '', concurrency_limit: 10 });
    refresh();
  }
  async function toggle(queue: Queue) {
    await api.patchQueue(queue.id, { status: queue.status === 'paused' ? 'active' : 'paused' });
    refresh();
  }

  return (
    <Page title="Queues">
      <div className="grid cols-2">
        <Panel title="New project">
          <form className="inline-form" onSubmit={addProject}>
            <input aria-label="project name" placeholder="project name" value={projName} onChange={(e) => setProjName(e.target.value)} style={{ flex: 1 }} />
            <button className="btn">Create</button>
          </form>
        </Panel>
        <Panel title="New queue">
          <form className="inline-form" onSubmit={addQueue}>
            <select aria-label="project" value={q.projectId || projects[0]?.id || 0} onChange={(e) => setQ({ ...q, projectId: Number(e.target.value) })}>
              {projects.length === 0 && <option value={0}>— no project —</option>}
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input aria-label="queue name" placeholder="queue name" value={q.name} onChange={(e) => setQ({ ...q, name: e.target.value })} style={{ flex: 1 }} />
            <input type="number" min={1} aria-label="concurrency limit" title="concurrency limit" value={q.concurrency_limit} onChange={(e) => setQ({ ...q, concurrency_limit: Number(e.target.value) })} style={{ width: 70 }} />
            <button className="btn" disabled={projects.length === 0}>Create</button>
          </form>
        </Panel>
      </div>

      {projects.length === 0 && <div className="panel mt"><div className="empty">No projects yet. Create one above to start adding queues.</div></div>}

      {projects.map((p) => (
        <div className="mt-lg" key={p.id}>
          <div className="between" style={{ marginBottom: 10 }}>
            <span className="eyebrow">project · {p.name}</span>
            <span className="dim mono" style={{ fontSize: 11 }}>{p.queues.length} queue{p.queues.length === 1 ? '' : 's'}</span>
          </div>
          <div className="panel">
            {p.queues.length === 0
              ? <div className="empty">no queues in this project</div>
              : (
                <table className="data">
                  <thead><tr><th>Queue</th><th>Priority</th><th>Concurrency</th><th>Status</th><th className="right">Actions</th></tr></thead>
                  <tbody>
                    {p.queues.map((queue) => (
                      <tr key={queue.id}>
                        <td><Link className="rowlink" to={`/queues/${queue.id}`}>{queue.name}</Link></td>
                        <td className="num">{queue.priority}</td>
                        <td className="num">{queue.concurrency_limit}</td>
                        <td><StatePill status={queue.status === 'paused' ? 'paused' : 'active'} /></td>
                        <td className="right">
                          <button className="btn btn--ghost btn--sm" onClick={() => toggle(queue)}>
                            {queue.status === 'paused' ? 'Resume' : 'Pause'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>
        </div>
      ))}
    </Page>
  );
}

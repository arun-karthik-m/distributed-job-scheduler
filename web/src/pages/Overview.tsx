import { usePoll } from '../hooks';
import { api } from '../api';
import { Page } from '../App';
import { Stat, StateTrack, Sparkline, Panel } from '../components';

export function Overview() {
  const { data: m, error } = usePoll(() => api.metrics(), [], 3000);
  const { data: tp } = usePoll(() => api.throughput(), [], 5000);
  const jobs = m?.jobs ?? {};
  const total = Object.values(jobs).reduce((a, b) => a + b, 0);
  const points = (tp?.data ?? []).map((d) => d.n);
  const completed30 = points.reduce((a, b) => a + b, 0);
  const dlq = jobs.DLQ ?? 0;

  return (
    <Page title="Overview" action={error ? <span className="err" style={{ margin: 0 }}>API: {error}</span> : undefined}>
      <div className="grid cols-4">
        <Stat label="Total jobs" value={total} foot="across all states" />
        <Stat label="Running" value={jobs.RUNNING ?? 0} foot="in flight now" />
        <Stat label="Completed" value={jobs.COMPLETED ?? 0} foot="lifetime" />
        <Stat label="Dead-letter" value={dlq} accent={dlq > 0} foot={dlq > 0 ? 'needs attention' : 'clear'} />
      </div>

      <div className="mt">
        <Panel title="System state" action={<span className="eyebrow">job lifecycle · live</span>}>
          <StateTrack stats={jobs} />
        </Panel>
      </div>

      <div className="grid cols-2 mt">
        <Panel title="Throughput" action={<span className="eyebrow">{completed30} done · 30m</span>}>
          <Sparkline points={points} />
        </Panel>
        <div className="grid cols-2">
          <Stat label="Workers alive" value={m?.workersAlive ?? 0} foot="heartbeat < 60s" />
          <Stat label="Waiting" value={(jobs.QUEUED ?? 0) + (jobs.SCHEDULED ?? 0)} foot="queued + scheduled" />
        </div>
      </div>
    </Page>
  );
}

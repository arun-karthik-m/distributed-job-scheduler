// M2: worker service — drain, concurrent execution, graceful shutdown, heartbeat.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, seedQueue, addJobs, makeWorker, sleep, countStatus, leaseExpiry } from './helpers.ts';
import { Worker } from '../src/worker.ts';
import { claimJob, startJob, heartbeatJob } from '../src/claim.ts';

before(async () => { await pool.query('TRUNCATE organizations, workers RESTART IDENTITY CASCADE'); });
after(async () => { await pool.end(); });

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (await cond()) return; await sleep(20); }
  throw new Error('waitFor timed out');
}

test('worker drains a queue: all 12 jobs reach COMPLETED', async () => {
  const { projectId, queueId } = await seedQueue({ concurrency: 5 });
  await addJobs(projectId, queueId, 12);
  const w = new Worker(pool, { queueId, concurrency: 5, leaseSeconds: 30, pollMs: 10, handler: async () => {} });
  await w.start();
  await waitFor(async () => (await countStatus(queueId, 'COMPLETED')) === 12, 5000);
  await w.stop();
  assert.equal(await countStatus(queueId, 'COMPLETED'), 12);
});

test('graceful shutdown drains in-flight jobs — no orphans left CLAIMED/RUNNING', async () => {
  const { projectId, queueId } = await seedQueue({ concurrency: 3 });
  await addJobs(projectId, queueId, 3);
  const w = new Worker(pool, { queueId, concurrency: 3, leaseSeconds: 30, pollMs: 5, handler: async () => sleep(150) });
  await w.start();
  await waitFor(async () => (await countStatus(queueId, 'RUNNING')) === 3, 2000); // all 3 in flight
  await w.stop();                                                                  // must wait them out
  assert.equal(await countStatus(queueId, 'CLAIMED') + await countStatus(queueId, 'RUNNING'), 0);
  assert.equal(await countStatus(queueId, 'COMPLETED'), 3);
});

test('a failing handler records a FAILED execution and never COMPLETEs the job', async () => {
  // (Post-M4: a failure is retried/dead-lettered, not left terminal — so assert on the outcome
  // that actually holds: a FAILED execution row exists and the job never reaches COMPLETED.)
  const { projectId, queueId } = await seedQueue();
  await addJobs(projectId, queueId, 1);
  const w = new Worker(pool, {
    queueId, concurrency: 1, leaseSeconds: 30, pollMs: 10,
    handler: async () => { throw new Error('boom'); },
  });
  await w.start();
  await waitFor(async () => {
    const r = await pool.query(`SELECT count(*)::int AS n FROM job_executions WHERE status='FAILED'`);
    return r.rows[0].n >= 1;
  }, 3000);
  await w.stop();
  assert.equal(await countStatus(queueId, 'COMPLETED'), 0);
});

test('records a job_executions row per attempt with worker + timestamps (C26–C29)', async () => {
  const { projectId, queueId } = await seedQueue();
  const [jobId] = await addJobs(projectId, queueId, 1);
  const w = new Worker(pool, { queueId, concurrency: 1, leaseSeconds: 30, pollMs: 10, handler: async () => {} });
  await w.start();
  await waitFor(async () => (await countStatus(queueId, 'COMPLETED')) === 1, 3000);
  await w.stop();
  const r = await pool.query(
    `SELECT attempt, worker_id, status, started_at, finished_at FROM job_executions WHERE job_id=$1`, [jobId]);
  assert.equal(r.rowCount, 1);
  assert.equal(r.rows[0].status, 'COMPLETED');
  assert.ok(r.rows[0].worker_id, 'worker assignment recorded');
  assert.ok(r.rows[0].started_at && r.rows[0].finished_at, 'start + finish timestamps recorded');
  const logs = await pool.query(`SELECT level, message FROM job_logs WHERE job_id=$1 ORDER BY ts, id`, [jobId]);
  assert.ok(logs.rows.some((l) => l.message.includes('running')), 'wrote a running log line');
  assert.ok(logs.rows.some((l) => l.message === 'completed'), 'wrote a completed log line');
});

test('C17: heartbeat extends the lease and is fenced', async () => {
  const { projectId, queueId } = await seedQueue();
  const [jobId] = await addJobs(projectId, queueId, 1);
  const wid = await makeWorker('hb');
  const c = await claimJob(pool, queueId, wid, 1);   // 1-second lease
  assert.ok(c);
  await startJob(pool, c.id, c.lease_token);
  const before = await leaseExpiry(jobId);
  assert.equal(await heartbeatJob(pool, jobId, c.lease_token, wid, 60), true);
  const after = await leaseExpiry(jobId);
  assert.ok(after.getTime() - before.getTime() > 30_000, 'lease should extend by ~60s');
  // fencing: a stale token cannot extend the lease
  assert.equal(await heartbeatJob(pool, jobId, c.lease_token + 999, wid, 60), false);
});

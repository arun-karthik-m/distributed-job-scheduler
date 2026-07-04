// M4: retry strategies + Dead Letter Queue (I4/I5).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, seedQueue, makeWorker, attachPolicy, countStatus, sleep } from './helpers.ts';
import { claimJob, startJob, failJob } from '../src/claim.ts';
import { enqueueImmediate } from '../src/jobs.ts';
import { backoffSeconds, retryOrDeadLetter, requeueFromDlq } from '../src/retry.ts';
import { Worker } from '../src/worker.ts';

before(async () => { await pool.query('TRUNCATE organizations, workers RESTART IDENTITY CASCADE'); });
after(async () => { await pool.end(); });

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (await cond()) return; await sleep(20); }
  throw new Error('waitFor timed out');
}

// Drive a fresh job to FAILED with a given attempts count, and return its id.
async function failedJob(projectId: number, queueId: number, attempts: number): Promise<number> {
  const id = await enqueueImmediate(pool, projectId, queueId);
  const c = await claimJob(pool, queueId, await makeWorker(), 30);
  await startJob(pool, c!.id, c!.lease_token);
  await pool.query(`UPDATE jobs SET attempts=$2 WHERE id=$1`, [id, attempts]);
  await failJob(pool, id, c!.lease_token);
  return id;
}

test('backoff strategies compute the right delays', () => {
  assert.equal(backoffSeconds('fixed', 5, 3), 5);
  assert.equal(backoffSeconds('linear', 5, 3), 15);
  assert.equal(backoffSeconds('exponential', 5, 1), 5);
  assert.equal(backoffSeconds('exponential', 5, 3), 20);
});

test('under the cap → retried with backoff (QUEUED, run_at pushed out)', async () => {
  const { projectId, queueId } = await seedQueue();
  await attachPolicy(queueId, projectId, { strategy: 'fixed', base: 60, maxAttempts: 3 });
  const id = await failedJob(projectId, queueId, 1);
  assert.equal(await retryOrDeadLetter(pool, id, 'boom'), 'retried');
  const r = await pool.query(`SELECT status, run_at > now() AS future FROM jobs WHERE id=$1`, [id]);
  assert.equal(r.rows[0].status, 'QUEUED');
  assert.equal(r.rows[0].future, true);
});

test('at the cap → dead-lettered (DLQ status + a queryable DLQ row)', async () => {
  const { projectId, queueId } = await seedQueue();
  await attachPolicy(queueId, projectId, { strategy: 'fixed', base: 1, maxAttempts: 2 });
  const id = await failedJob(projectId, queueId, 2);
  assert.equal(await retryOrDeadLetter(pool, id, 'permanent'), 'dead-lettered');
  assert.equal(await countStatus(queueId, 'DLQ'), 1);
  const dlq = await pool.query(`SELECT reason, attempts FROM dead_letter_queue WHERE job_id=$1`, [id]);
  assert.equal(dlq.rowCount, 1);
  assert.equal(dlq.rows[0].reason, 'permanent');
});

test('I5: a dead-lettered job is inert — never claimed', async () => {
  const { projectId, queueId } = await seedQueue();
  await attachPolicy(queueId, projectId, { strategy: 'fixed', base: 1, maxAttempts: 1 });
  const id = await failedJob(projectId, queueId, 1);
  await retryOrDeadLetter(pool, id, 'x');
  assert.equal(await claimJob(pool, queueId, await makeWorker(), 30), null);
});

test('manual requeue moves a job out of the DLQ and it becomes claimable', async () => {
  const { projectId, queueId } = await seedQueue();
  await attachPolicy(queueId, projectId, { strategy: 'fixed', base: 1, maxAttempts: 1 });
  const id = await failedJob(projectId, queueId, 1);
  await retryOrDeadLetter(pool, id, 'x');
  assert.equal(await requeueFromDlq(pool, id), true);
  assert.equal(await countStatus(queueId, 'DLQ'), 0);
  const dlq = await pool.query(`SELECT 1 FROM dead_letter_queue WHERE job_id=$1`, [id]);
  assert.equal(dlq.rowCount, 0);
  const c = await claimJob(pool, queueId, await makeWorker(), 30);
  assert.equal(c?.id, id);
});

test('integration: a permanently-failing job is retried to the cap, then dead-lettered', async () => {
  const { projectId, queueId } = await seedQueue();
  await attachPolicy(queueId, projectId, { strategy: 'fixed', base: 0, maxAttempts: 3 }); // no delay, 3 tries
  await enqueueImmediate(pool, projectId, queueId);
  const w = new Worker(pool, {
    queueId, concurrency: 1, leaseSeconds: 30, pollMs: 10,
    handler: async () => { throw new Error('always fails'); },
  });
  await w.start();
  await waitFor(async () => (await countStatus(queueId, 'DLQ')) === 1, 4000);
  await w.stop();
  assert.equal(await countStatus(queueId, 'DLQ'), 1);
  const execs = await pool.query(`SELECT count(*)::int AS n FROM job_executions`);
  assert.equal(execs.rows[0].n, 3, 'exactly max_attempts execution records');
});

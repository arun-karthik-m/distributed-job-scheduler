// Concurrency falsification tests for M1 — each proves a named invariant and could plausibly
// fail if the claim logic were wrong. These are the tests that matter (PLAN testing philosophy).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, seedQueue, addJobs, makeWorker } from './helpers.ts';
import { claimJob, startJob, completeJob, reclaimExpired } from '../src/claim.ts';

before(async () => { await pool.query('TRUNCATE organizations, workers RESTART IDENTITY CASCADE'); });
after(async () => { await pool.end(); });

test('I1: 20 workers race a single job -> exactly one wins', async () => {
  const { projectId, queueId } = await seedQueue();
  await addJobs(projectId, queueId, 1);
  const workers = await Promise.all(Array.from({ length: 20 }, (_, i) => makeWorker(`w${i}`)));
  const results = await Promise.all(workers.map((w) => claimJob(pool, queueId, w, 30)));
  assert.equal(results.filter(Boolean).length, 1);
});

test('I10: concurrency limit is never exceeded under a 50-way flood', async () => {
  const { projectId, queueId } = await seedQueue({ concurrency: 5 });
  await addJobs(projectId, queueId, 100);
  const workers = await Promise.all(Array.from({ length: 50 }, (_, i) => makeWorker(`c${i}`)));
  // None of these complete, so every successful claim stays in-flight (CLAIMED).
  const results = await Promise.all(workers.map((w) => claimJob(pool, queueId, w, 30)));
  assert.equal(results.filter(Boolean).length, 5, 'more claims succeeded than the limit');
  const inflight = await pool.query(
    `SELECT count(*)::int AS n FROM jobs WHERE queue_id=$1 AND status IN ('CLAIMED','RUNNING')`,
    [queueId]);
  assert.equal(inflight.rows[0].n, 5);
});

test('I11: a paused queue yields nothing', async () => {
  const { projectId, queueId } = await seedQueue({ status: 'paused' });
  await addJobs(projectId, queueId, 3);
  const w = await makeWorker();
  assert.equal(await claimJob(pool, queueId, w, 30), null);
});

test('I3: a stale worker cannot complete a reassigned job (fencing)', async () => {
  const { projectId, queueId } = await seedQueue();
  const [jobId] = await addJobs(projectId, queueId, 1);
  const a = await makeWorker('A');
  const b = await makeWorker('B');

  const claimA = await claimJob(pool, queueId, a, 30);
  assert.ok(claimA);
  await startJob(pool, claimA.id, claimA.lease_token);

  // A's lease expires; the scheduler reclaims the job back to the pool.
  await pool.query(`UPDATE jobs SET lease_expires_at = now() - interval '1 minute' WHERE id=$1`, [jobId]);
  assert.equal(await reclaimExpired(pool), 1);

  // B claims it -> a higher fencing token.
  const claimB = await claimJob(pool, queueId, b, 30);
  assert.ok(claimB);
  assert.equal(claimB.id, jobId);
  assert.ok(claimB.lease_token > claimA.lease_token);
  await startJob(pool, claimB.id, claimB.lease_token);

  // Stale A tries to complete with its old token -> no-op.
  assert.equal(await completeJob(pool, jobId, claimA.lease_token), false);
  // B completes with the valid token -> success.
  assert.equal(await completeJob(pool, jobId, claimB.lease_token), true);
});

test('C4: higher-priority job is claimed first', async () => {
  const { projectId, queueId } = await seedQueue();
  await addJobs(projectId, queueId, 1, 0);                 // low priority
  const hi = await addJobs(projectId, queueId, 1, 10);     // high priority
  const w = await makeWorker();
  const c = await claimJob(pool, queueId, w, 30);
  assert.equal(c?.id, hi[0]);
});

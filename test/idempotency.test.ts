// B9: at-least-once delivery + idempotency key → the effect is applied exactly once even when a
// crash causes the job to run twice. This is the honest guarantee (not "exactly-once delivery").
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, seedQueue, makeWorker } from './helpers.ts';
import { claimJob, startJob, completeJob, reclaimExpired } from '../src/claim.ts';

before(async () => { await pool.query('TRUNCATE organizations, workers RESTART IDENTITY CASCADE'); });
after(async () => { await pool.end(); });

test('at-least-once + idempotency key → effect once despite a re-run after a crash', async () => {
  const { projectId, queueId } = await seedQueue();
  const r = await pool.query(
    `INSERT INTO jobs(project_id,queue_id,type,idempotency_key) VALUES($1,$2,'immediate','charge-42') RETURNING id`,
    [projectId, queueId]);
  const jobId = r.rows[0].id;

  // An idempotent handler: applies the effect once per key, no-ops on replay.
  const applied = new Set<string>();
  let effects = 0;
  const handler = (key: string) => { if (applied.has(key)) return; applied.add(key); effects++; };

  // Execution 1: worker A claims, starts, applies the effect — then CRASHES before completing.
  const a = await claimJob(pool, queueId, await makeWorker('A'), 1);
  assert.ok(a);
  await startJob(pool, a.id, a.lease_token);
  handler('charge-42');                          // effect applied
  // (no completeJob — simulate a crash) → lease expires → scheduler reclaims it
  await pool.query(`UPDATE jobs SET lease_expires_at = now() - interval '1 minute' WHERE id=$1`, [jobId]);
  assert.equal(await reclaimExpired(pool), 1);

  // Execution 2: worker B re-claims the same job (at-least-once) and runs the handler again.
  const b = await claimJob(pool, queueId, await makeWorker('B'), 30);
  assert.ok(b);
  assert.equal(b.id, jobId);
  await startJob(pool, b.id, b.lease_token);
  handler('charge-42');                          // idempotent no-op
  assert.equal(await completeJob(pool, b.id, b.lease_token), true);

  assert.equal(effects, 1, 'ran twice, but the effect applied exactly once');
});

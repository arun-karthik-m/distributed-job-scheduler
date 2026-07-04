// M3: the five job types + scheduler sweeps.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, seedQueue, makeWorker, countStatus } from './helpers.ts';
import { claimJob } from '../src/claim.ts';
import {
  enqueueImmediate, enqueueDelayed, enqueueScheduled, enqueueBatch, createSchedule,
} from '../src/jobs.ts';
import { promoteDue, materializeCron } from '../src/scheduler.ts';

before(async () => { await pool.query('TRUNCATE organizations, workers RESTART IDENTITY CASCADE'); });
after(async () => { await pool.end(); });

test('immediate job is claimable right away', async () => {
  const { projectId, queueId } = await seedQueue();
  const id = await enqueueImmediate(pool, projectId, queueId, { k: 1 });
  const c = await claimJob(pool, queueId, await makeWorker(), 30);
  assert.equal(c?.id, id);
});

test('delayed job is NOT claimable until its delay elapses (I8)', async () => {
  const { projectId, queueId } = await seedQueue();
  await enqueueDelayed(pool, projectId, queueId, 3600, {});   // due in 1h
  assert.equal(await claimJob(pool, queueId, await makeWorker(), 30), null);
});

test('scheduled job waits in SCHEDULED and is promoted when due', async () => {
  const { projectId, queueId } = await seedQueue();
  const past = await enqueueScheduled(pool, projectId, queueId, new Date(Date.now() - 1000));
  const future = await enqueueScheduled(pool, projectId, queueId, new Date(Date.now() + 3600_000));
  assert.equal(await countStatus(queueId, 'SCHEDULED'), 2);
  assert.equal(await promoteDue(pool), 1);                    // only the past-due one
  assert.equal(await countStatus(queueId, 'QUEUED'), 1);
  const c = await claimJob(pool, queueId, await makeWorker(), 30);
  assert.equal(c?.id, past);
  // the future one is still parked
  assert.equal(await countStatus(queueId, 'SCHEDULED'), 1);
  assert.ok(future);
});

test('batch creates N sibling jobs sharing one batch_id', async () => {
  const { projectId, queueId } = await seedQueue();
  const ids = await enqueueBatch(pool, projectId, queueId, [{ i: 1 }, { i: 2 }, { i: 3 }]);
  assert.equal(ids.length, 3);
  const r = await pool.query(
    `SELECT count(DISTINCT batch_id)::int AS groups, count(*)::int AS n FROM jobs WHERE id = ANY($1)`, [ids]);
  assert.equal(r.rows[0].groups, 1);   // all share one batch_id
  assert.equal(r.rows[0].n, 3);
});

test('recurring: materializeCron enqueues one occurrence and advances next_run_at', async () => {
  const { projectId, queueId } = await seedQueue();
  await createSchedule(pool, projectId, queueId, '* * * * *', new Date(Date.now() - 1000)); // due now
  assert.equal(await materializeCron(pool), 1);
  assert.equal(await countStatus(queueId, 'QUEUED'), 1);      // one occurrence enqueued
  const s = await pool.query(`SELECT next_run_at FROM scheduled_jobs`);
  assert.ok(s.rows[0].next_run_at.getTime() > Date.now(), 'next_run_at advanced into the future');
  // a second sweep with no newly-due schedule creates nothing
  assert.equal(await materializeCron(pool), 0);
});

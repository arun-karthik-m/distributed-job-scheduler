// Falsification test for invariant I2 (PLAN §4, ledger C19).
// Proves the state machine is enforced at the DB layer: illegal transitions are rejected even
// via a raw UPDATE, not merely in application code. This test FAILS if the trigger is removed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let projectId: number;
let queueId: number;

before(async () => {
  await pool.query('TRUNCATE organizations, workers RESTART IDENTITY CASCADE');
  const org = await pool.query(`INSERT INTO organizations(name) VALUES('t') RETURNING id`);
  const proj = await pool.query(
    `INSERT INTO projects(org_id,name) VALUES($1,'p') RETURNING id`, [org.rows[0].id]);
  projectId = proj.rows[0].id;
  const q = await pool.query(
    `INSERT INTO queues(project_id,name) VALUES($1,'q') RETURNING id`, [projectId]);
  queueId = q.rows[0].id;
});

after(async () => { await pool.end(); });

async function newJob(status = 'QUEUED'): Promise<number> {
  const r = await pool.query(
    `INSERT INTO jobs(project_id,queue_id,type,status) VALUES($1,$2,'immediate',$3) RETURNING id`,
    [projectId, queueId, status]);
  return r.rows[0].id;
}

test('legal transition QUEUED -> CLAIMED is allowed', async () => {
  const id = await newJob();
  await pool.query(`UPDATE jobs SET status='CLAIMED' WHERE id=$1`, [id]);
  const r = await pool.query(`SELECT status FROM jobs WHERE id=$1`, [id]);
  assert.equal(r.rows[0].status, 'CLAIMED');
});

test('illegal transition QUEUED -> COMPLETED is rejected at the DB layer', async () => {
  const id = await newJob();
  await assert.rejects(
    pool.query(`UPDATE jobs SET status='COMPLETED' WHERE id=$1`, [id]),
    /illegal job transition/);
});

test('illegal initial status COMPLETED is rejected on insert', async () => {
  await assert.rejects(newJob('COMPLETED'), /illegal initial job status/);
});

test('terminal COMPLETED cannot transition further', async () => {
  const id = await newJob();
  await pool.query(`UPDATE jobs SET status='CLAIMED' WHERE id=$1`, [id]);
  await pool.query(`UPDATE jobs SET status='RUNNING' WHERE id=$1`, [id]);
  await pool.query(`UPDATE jobs SET status='COMPLETED' WHERE id=$1`, [id]);
  await assert.rejects(
    pool.query(`UPDATE jobs SET status='QUEUED' WHERE id=$1`, [id]),
    /illegal job transition/);
});

// Live demo seeder: sets up a demo account with a steady, realistic workload so the dashboard
// shows every lifecycle state in motion. Run:  npm run demo   (Ctrl-C to stop)
//   Log in at http://localhost:5173 with  demo@sched.ctl / demo1234
import pg from 'pg';
import { hashPassword } from '../src/auth.ts';
import { enqueueImmediate, enqueueDelayed, enqueueScheduled, enqueueBatch, createSchedule } from '../src/jobs.ts';
import { promoteDue, materializeCron } from '../src/scheduler.ts';
import { reclaimExpired } from '../src/claim.ts';
import { Worker } from '../src/worker.ts';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const EMAIL = 'demo@sched.ctl';
const PW = 'demo1234';

// clear stale test workers so the Workers view is clean
await pool.query(`DELETE FROM workers WHERE last_seen < now() - interval '5 minutes'`);

// idempotent demo tenant
let user = await pool.query(`SELECT org_id FROM users WHERE email=$1`, [EMAIL]);
let orgId: number;
if (user.rowCount === 0) {
  const org = await pool.query(`INSERT INTO organizations(name) VALUES('Demo Co') RETURNING id`);
  orgId = org.rows[0].id;
  await pool.query(`INSERT INTO users(org_id,email,password_hash) VALUES($1,$2,$3)`, [orgId, EMAIL, hashPassword(PW)]);
} else {
  orgId = user.rows[0].org_id;
}

async function ensureQueue(project: string, name: string, concurrency: number, strategy: string) {
  let p = await pool.query(`SELECT id FROM projects WHERE org_id=$1 AND name=$2`, [orgId, project]);
  if (p.rowCount === 0) p = await pool.query(`INSERT INTO projects(org_id,name) VALUES($1,$2) RETURNING id`, [orgId, project]);
  const projectId = p.rows[0].id;
  let q = await pool.query(`SELECT id FROM queues WHERE project_id=$1 AND name=$2`, [projectId, name]);
  if (q.rowCount === 0) {
    const rp = await pool.query(
      `INSERT INTO retry_policies(project_id,name,strategy,base_delay_s,max_attempts) VALUES($1,'default',$2,2,3) RETURNING id`,
      [projectId, strategy]);
    q = await pool.query(
      `INSERT INTO queues(project_id,name,concurrency_limit,retry_policy_id) VALUES($1,$2,$3,$4) RETURNING id`,
      [projectId, name, concurrency, rp.rows[0].id]);
  }
  return { projectId, queueId: q.rows[0].id };
}

const emails = await ensureQueue('notifications', 'emails', 5, 'exponential');
const reports = await ensureQueue('analytics', 'reports', 2, 'linear');

// a handler that mostly succeeds but fails ~25% of the time → exercises retry + DLQ live
const flaky = async () => {
  await new Promise((r) => setTimeout(r, 200 + Math.random() * 700));
  if (Math.random() < 0.25) throw new Error('smtp: connection timed out');
};
const workers = [
  new Worker(pool, { name: 'worker-a', queueId: emails.queueId, concurrency: 5, leaseSeconds: 30, pollMs: 200, handler: flaky }),
  new Worker(pool, { name: 'worker-b', queueId: emails.queueId, concurrency: 5, leaseSeconds: 30, pollMs: 200, handler: flaky }),
  new Worker(pool, { name: 'worker-c', queueId: reports.queueId, concurrency: 2, leaseSeconds: 30, pollMs: 300, handler: flaky }),
];
for (const w of workers) await w.start();

// scheduler sweeps
const sched = setInterval(() => { void promoteDue(pool); void materializeCron(pool); void reclaimExpired(pool); }, 1500);

// steady stream of work across job types
await createSchedule(pool, emails.projectId, emails.queueId, '* * * * *', new Date(Date.now() + 60_000), { kind: 'minutely-report' });
let n = 0;
const feed = setInterval(async () => {
  await enqueueImmediate(pool, emails.projectId, emails.queueId, { to: `user${n++}@example.com`, kind: 'welcome' });
  if (n % 3 === 0) await enqueueImmediate(pool, reports.projectId, reports.queueId, { report: 'daily', n });
  if (n % 5 === 0) await enqueueDelayed(pool, emails.projectId, emails.queueId, 8, { kind: 'digest' });
  if (n % 11 === 0) await enqueueBatch(pool, emails.projectId, emails.queueId, Array.from({ length: 5 }, (_, i) => ({ i })));
}, 800);

console.log(`\n  Demo live — log in at http://localhost:5173\n    email:    ${EMAIL}\n    password: ${PW}\n\n  Ctrl-C to stop.\n`);

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    clearInterval(feed); clearInterval(sched);
    await Promise.all(workers.map((w) => w.stop()));
    await pool.end();
    process.exit(0);
  });
}

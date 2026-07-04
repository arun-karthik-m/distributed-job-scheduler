import pg from 'pg';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function seedQueue(
  opts: { concurrency?: number; status?: 'active' | 'paused' } = {},
): Promise<{ projectId: number; queueId: number }> {
  const org = await pool.query(`INSERT INTO organizations(name) VALUES('t') RETURNING id`);
  const proj = await pool.query(
    `INSERT INTO projects(org_id,name) VALUES($1,'p') RETURNING id`, [org.rows[0].id]);
  const projectId = proj.rows[0].id;
  const q = await pool.query(
    `INSERT INTO queues(project_id,name,concurrency_limit,status) VALUES($1,'q',$2,$3) RETURNING id`,
    [projectId, opts.concurrency ?? 10, opts.status ?? 'active']);
  return { projectId, queueId: q.rows[0].id };
}

export async function addJobs(
  projectId: number, queueId: number, n: number, priority = 0,
): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = await pool.query(
      `INSERT INTO jobs(project_id,queue_id,type,priority) VALUES($1,$2,'immediate',$3) RETURNING id`,
      [projectId, queueId, priority]);
    ids.push(r.rows[0].id);
  }
  return ids;
}

export async function makeWorker(name = 'w'): Promise<number> {
  const r = await pool.query(`INSERT INTO workers(name) VALUES($1) RETURNING id`, [name]);
  return r.rows[0].id;
}

export async function attachPolicy(
  queueId: number, projectId: number,
  o: { strategy: string; base: number; maxAttempts: number },
): Promise<number> {
  const r = await pool.query(
    `INSERT INTO retry_policies(project_id,name,strategy,base_delay_s,max_attempts)
     VALUES($1,'p',$2,$3,$4) RETURNING id`,
    [projectId, o.strategy, o.base, o.maxAttempts]);
  await pool.query(`UPDATE queues SET retry_policy_id=$1 WHERE id=$2`, [r.rows[0].id, queueId]);
  return r.rows[0].id;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function countStatus(queueId: number, status: string): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM jobs WHERE queue_id=$1 AND status=$2`, [queueId, status]);
  return r.rows[0].n;
}

export async function leaseExpiry(jobId: number): Promise<Date> {
  const r = await pool.query(`SELECT lease_expires_at FROM jobs WHERE id=$1`, [jobId]);
  return r.rows[0].lease_expires_at;
}

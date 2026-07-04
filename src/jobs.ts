// M3: the five job types, created through one small module (the REST layer in M5 calls these).
// immediate/delayed/batch land straight in QUEUED; scheduled waits in SCHEDULED for the scheduler
// to promote it; recurring lives in scheduled_jobs and the scheduler materializes each occurrence.
import type pg from 'pg';

type Q = pg.Pool | pg.PoolClient;

// immediate — runnable now.
export async function enqueueImmediate(
  db: Q, projectId: number, queueId: number, payload: unknown = {},
): Promise<number> {
  const r = await db.query(
    `INSERT INTO jobs(project_id,queue_id,type,status,run_at,payload)
     VALUES($1,$2,'immediate','QUEUED',now(),$3) RETURNING id`,
    [projectId, queueId, payload]);
  return r.rows[0].id;
}

// delayed — QUEUED but invisible to claim until now()+delay (I8 gates on run_at).
export async function enqueueDelayed(
  db: Q, projectId: number, queueId: number, delaySeconds: number, payload: unknown = {},
): Promise<number> {
  const r = await db.query(
    `INSERT INTO jobs(project_id,queue_id,type,status,run_at,payload)
     VALUES($1,$2,'delayed','QUEUED', now() + make_interval(secs => $3), $4) RETURNING id`,
    [projectId, queueId, delaySeconds, payload]);
  return r.rows[0].id;
}

// scheduled — parked in SCHEDULED until the scheduler promotes it at run_at.
export async function enqueueScheduled(
  db: Q, projectId: number, queueId: number, runAt: Date, payload: unknown = {},
): Promise<number> {
  const r = await db.query(
    `INSERT INTO jobs(project_id,queue_id,type,status,run_at,payload)
     VALUES($1,$2,'scheduled','SCHEDULED',$3,$4) RETURNING id`,
    [projectId, queueId, runAt, payload]);
  return r.rows[0].id;
}

// batch — N independent sibling jobs sharing a batch_id (no partial-batch atomicity, by design).
export async function enqueueBatch(
  db: Q, projectId: number, queueId: number, payloads: unknown[],
): Promise<number[]> {
  const bid = (await db.query(`SELECT nextval('batch_id_seq') AS id`)).rows[0].id;
  const ids: number[] = [];
  for (const p of payloads) {
    const r = await db.query(
      `INSERT INTO jobs(project_id,queue_id,type,status,run_at,payload,batch_id)
       VALUES($1,$2,'batch','QUEUED',now(),$3,$4) RETURNING id`,
      [projectId, queueId, p, bid]);
    ids.push(r.rows[0].id);
  }
  return ids;
}

// recurring (cron) — a schedule row; the scheduler enqueues one occurrence each time it comes due.
export async function createSchedule(
  db: Q, projectId: number, queueId: number, cronExpr: string, nextRunAt: Date, payload: unknown = {},
): Promise<number> {
  const r = await db.query(
    `INSERT INTO scheduled_jobs(project_id,queue_id,cron_expr,next_run_at,payload)
     VALUES($1,$2,$3,$4,$5) RETURNING id`,
    [projectId, queueId, cronExpr, nextRunAt, payload]);
  return r.rows[0].id;
}

// M3: the scheduler process. Three idempotent sweeps on a tick (PLAN §0):
//   promoteDue     — SCHEDULED jobs whose run_at has arrived -> QUEUED
//   materializeCron— due recurring schedules -> one queued occurrence + advance next_run_at
//   reclaimExpired — dead workers' leases returned to the pool (I7)
// Single active instance (HA out of scope); due-rows are read FOR UPDATE SKIP LOCKED so a crash,
// restart, or accidental second instance never skips or double-fires.
import type pg from 'pg';
import cronParser from 'cron-parser';
import { reclaimExpired } from './claim.ts';

// SCHEDULED -> QUEUED once due (I8). The state-machine trigger permits exactly this edge.
export async function promoteDue(db: pg.Pool | pg.PoolClient): Promise<number> {
  const r = await db.query(
    `UPDATE jobs SET status='QUEUED' WHERE status='SCHEDULED' AND run_at <= now()`);
  return r.rowCount ?? 0;
}

// For each due schedule: enqueue one occurrence and advance next_run_at, in one transaction.
// currentDate=now() so missed occurrences are skipped rather than replayed in a burst.
export async function materializeCron(pool: pg.Pool): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const due = await client.query(
      `SELECT id, queue_id, project_id, cron_expr, payload FROM scheduled_jobs
       WHERE active AND next_run_at <= now()
       FOR UPDATE SKIP LOCKED`);
    for (const s of due.rows) {
      await client.query(
        `INSERT INTO jobs(project_id,queue_id,type,status,run_at,payload)
         VALUES($1,$2,'recurring','QUEUED',now(),$3)`,
        [s.project_id, s.queue_id, s.payload]);
      const next = cronParser.parseExpression(s.cron_expr, { currentDate: new Date() }).next().toDate();
      await client.query(`UPDATE scheduled_jobs SET next_run_at=$2 WHERE id=$1`, [s.id, next]);
    }
    await client.query('COMMIT');
    return due.rowCount ?? 0;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export class Scheduler {
  private readonly pool: pg.Pool;
  private readonly tickMs: number;
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(pool: pg.Pool, tickMs = 1000) {
    this.pool = pool;
    this.tickMs = tickMs;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;             // never overlap sweeps
    this.ticking = true;
    try {
      await promoteDue(this.pool);
      await materializeCron(this.pool);
      await reclaimExpired(this.pool);
    } finally {
      this.ticking = false;
    }
  }

  start(): void {
    this.timer = setInterval(() => { void this.tick(); }, this.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

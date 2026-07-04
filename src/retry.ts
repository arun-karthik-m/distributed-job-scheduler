// M4: retry strategies + Dead Letter Queue (invariants I4/I5).
// A failed job is either retried with backoff (attempts < cap) or dead-lettered (at the cap).
// The DLQ is terminal and inert: nothing auto-executes it; only requeueFromDlq() moves a job out.
import type pg from 'pg';

// Delay before the next attempt, given how many attempts have already been made.
export function backoffSeconds(strategy: string, base: number, attempt: number): number {
  switch (strategy) {
    case 'fixed':       return base;
    case 'linear':      return base * attempt;
    case 'exponential': return base * 2 ** (attempt - 1);
    default:            return base;
  }
}

// Called after a job fails (status='FAILED'). Decides retry vs dead-letter using the queue's
// retry policy (falling back to the job's own max_attempts / a fixed default).
export async function retryOrDeadLetter(
  pool: pg.Pool, jobId: number, reason: string,
): Promise<'retried' | 'dead-lettered'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const j = await client.query(
      `SELECT j.attempts, j.max_attempts, j.queue_id, j.project_id, j.payload,
              rp.strategy, rp.base_delay_s, rp.max_attempts AS policy_max
       FROM jobs j
       JOIN queues q ON q.id = j.queue_id
       LEFT JOIN retry_policies rp ON rp.id = q.retry_policy_id
       WHERE j.id = $1 AND j.status = 'FAILED'
       FOR UPDATE OF j`,
      [jobId]);
    if (j.rowCount === 0) { await client.query('ROLLBACK'); throw new Error('job not in FAILED state'); }
    const row = j.rows[0];
    const maxAttempts: number = row.policy_max ?? row.max_attempts;
    const strategy: string = row.strategy ?? 'fixed';
    const base: number = row.base_delay_s ?? 5;

    if (row.attempts < maxAttempts) {
      const delay = backoffSeconds(strategy, base, row.attempts);
      await client.query(
        `UPDATE jobs SET status='QUEUED', worker_id=NULL, run_at = now() + make_interval(secs => $2)
         WHERE id=$1`,
        [jobId, delay]);
      await client.query('COMMIT');
      return 'retried';
    }

    // Cap reached → dead-letter (I4). Terminal DLQ status + a queryable DLQ row (I5).
    await client.query(`UPDATE jobs SET status='DLQ' WHERE id=$1`, [jobId]);
    await client.query(
      `INSERT INTO dead_letter_queue(job_id,queue_id,project_id,reason,attempts,payload)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [jobId, row.queue_id, row.project_id, reason, row.attempts, row.payload]);
    await client.query('COMMIT');
    return 'dead-lettered';
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Manual requeue (C33): the ONLY path out of the DLQ. Resets the attempt budget.
export async function requeueFromDlq(pool: pg.Pool, jobId: number): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query(
      `UPDATE jobs SET status='QUEUED', worker_id=NULL, run_at=now(), attempts=0
       WHERE id=$1 AND status='DLQ'`,
      [jobId]);
    if (u.rowCount === 0) { await client.query('ROLLBACK'); return false; }
    await client.query(`DELETE FROM dead_letter_queue WHERE job_id=$1`, [jobId]);
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

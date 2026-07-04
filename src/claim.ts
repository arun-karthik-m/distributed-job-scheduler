// The heart of the scheduler: atomic claim + lease/fencing (PLAN §4, invariants I1/I3/I7/I8/I10/I11).
// Every operation is a single statement — no read-then-write gap, no long-lived transaction.
import type pg from 'pg';

type Q = pg.Pool | pg.PoolClient;

export interface Claimed {
  id: number;
  lease_token: number;
  payload: unknown;
}

// Claim one job from a queue, atomically. Returns null if nothing is claimable
// (queue empty/paused, all due jobs locked by peers, or the concurrency limit is full).
//
// Correctness (PLAN §4):
//  - locked_q ... FOR UPDATE  → serializes every claimer on THIS queue, so the in-flight
//    count cannot go stale between read and claim (I10). Without it, two claimers pick
//    different rows via SKIP LOCKED and both pass a stale count — the read-then-write race.
//  - status='active'          → paused queue yields nothing (I11).
//  - run_at <= now()          → delayed/scheduled jobs invisible until due (I8).
//  - FOR UPDATE OF j SKIP LOCKED → two claimers never grab the same job (I1).
//  - lease_token+1            → fencing token, bumped every claim (I3).
export async function claimJob(
  pool: pg.Pool, queueId: number, workerId: number, leaseSeconds: number,
): Promise<Claimed | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock the queue row — serializes every claimer on THIS queue. Missing/paused → nothing (I11).
    const ql = await client.query(
      `SELECT concurrency_limit FROM queues WHERE id=$1 AND status='active' FOR UPDATE`,
      [queueId]);
    if (ql.rowCount === 0) { await client.query('ROLLBACK'); return null; }

    // 2. Count in-flight in a SEPARATE statement, after the lock. In READ COMMITTED each statement
    //    gets a fresh snapshot, so this sees peers' already-committed claims (I10). Doing the count
    //    as a CTE in the same statement as the lock does NOT — one snapshot per statement — which is
    //    the bug that let 14 claims through a limit of 5. Proven by test/claim.test.ts I10.
    const cnt = await client.query(
      `SELECT count(*)::int AS n FROM jobs WHERE queue_id=$1 AND status IN ('CLAIMED','RUNNING')`,
      [queueId]);
    if (cnt.rows[0].n >= ql.rows[0].concurrency_limit) { await client.query('ROLLBACK'); return null; }

    // 3. Claim one due job: SKIP LOCKED for exclusivity (I1), run_at gate (I8), priority order,
    //    fencing token bump (I3).
    const r = await client.query(
      `UPDATE jobs SET status='CLAIMED', worker_id=$2, lease_token=lease_token+1,
         lease_expires_at = now() + make_interval(secs => $3), claimed_at = now()
       WHERE id = (
         SELECT id FROM jobs
         WHERE queue_id=$1 AND status='QUEUED' AND run_at <= now()
         ORDER BY priority DESC, run_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
       RETURNING id, lease_token, payload`,
      [queueId, workerId, leaseSeconds]);

    await client.query('COMMIT');
    return r.rows[0] ?? null;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// CLAIMED -> RUNNING, fenced: only the current lease holder may start the job.
export async function startJob(db: Q, jobId: number, leaseToken: number): Promise<boolean> {
  const r = await db.query(
    `UPDATE jobs SET status='RUNNING'
     WHERE id=$1 AND lease_token=$2 AND status='CLAIMED'`,
    [jobId, leaseToken],
  );
  return r.rowCount === 1;
}

// RUNNING -> COMPLETED, fenced (I3): a stale worker whose lease was reassigned gets rowCount 0
// and must discard its result.
export async function completeJob(db: Q, jobId: number, leaseToken: number): Promise<boolean> {
  const r = await db.query(
    `UPDATE jobs SET status='COMPLETED', completed_at=now()
     WHERE id=$1 AND lease_token=$2 AND status='RUNNING'`,
    [jobId, leaseToken],
  );
  return r.rowCount === 1;
}

// RUNNING -> FAILED, fenced. Retry vs dead-letter is decided later (M4); this just records failure.
export async function failJob(db: Q, jobId: number, leaseToken: number): Promise<boolean> {
  const r = await db.query(
    `UPDATE jobs SET status='FAILED'
     WHERE id=$1 AND lease_token=$2 AND status='RUNNING'`,
    [jobId, leaseToken],
  );
  return r.rowCount === 1;
}

// Heartbeat (C17): extend the lease, fenced — only the current holder of a RUNNING job may extend
// it. A stale worker whose job was reclaimed/reassigned gets rowCount 0 and stops.
export async function heartbeatJob(
  db: Q, jobId: number, leaseToken: number, workerId: number, leaseSeconds: number,
): Promise<boolean> {
  const r = await db.query(
    `UPDATE jobs SET lease_expires_at = now() + make_interval(secs => $4)
     WHERE id=$1 AND lease_token=$2 AND worker_id=$3 AND status='RUNNING'`,
    [jobId, leaseToken, workerId, leaseSeconds],
  );
  return r.rowCount === 1;
}

// Scheduler sweep (I7): return jobs whose lease expired to the pool. lease_token is NOT reset,
// so the next claim bumps it and fences out the old holder.
export async function reclaimExpired(db: Q): Promise<number> {
  const r = await db.query(
    `UPDATE jobs SET status='QUEUED', worker_id=NULL, run_at=now()
     WHERE status IN ('CLAIMED','RUNNING') AND lease_expires_at < now()`,
  );
  return r.rowCount ?? 0;
}

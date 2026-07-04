// M2: the worker service. Polls a queue, claims jobs atomically, runs them concurrently up to a
// local limit, heartbeats to hold its leases, and drains in-flight work on graceful shutdown.
// Concurrency correctness lives in claimJob (I1/I10); this file is the run loop around it.
import type pg from 'pg';
import { claimJob, startJob, completeJob, failJob, heartbeatJob } from './claim.ts';
import { retryOrDeadLetter } from './retry.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface WorkerOpts {
  queueId: number;
  concurrency: number;      // max jobs this worker runs in parallel
  leaseSeconds: number;     // lease length; heartbeat renews at 1/3 of it
  pollMs: number;
  handler: (payload: unknown) => Promise<void>;
  name?: string;
}

export class Worker {
  private readonly pool: pg.Pool;
  private readonly opts: WorkerOpts;
  private workerId = 0;
  private readonly inflight = new Map<number, number>();      // jobId -> lease_token
  private readonly running = new Set<Promise<void>>();
  private draining = false;
  private loopPromise?: Promise<void>;
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(pool: pg.Pool, opts: WorkerOpts) {
    this.pool = pool;
    this.opts = opts;
  }

  async start(): Promise<void> {
    const r = await this.pool.query(
      `INSERT INTO workers(name) VALUES($1) RETURNING id`, [this.opts.name ?? 'worker']);
    this.workerId = r.rows[0].id;
    this.heartbeatTimer = setInterval(
      () => { void this.heartbeat(); }, Math.max(100, Math.floor((this.opts.leaseSeconds * 1000) / 3)));
    this.loopPromise = this.loop();
  }

  // Graceful shutdown (C18): stop claiming, let in-flight jobs finish, then release the worker.
  async stop(): Promise<void> {
    this.draining = true;
    await this.loopPromise;                        // loop exits on the next check
    await Promise.allSettled([...this.running]);   // drain what's already running
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.pool.query(`UPDATE workers SET status='dead' WHERE id=$1`, [this.workerId]);
  }

  private async loop(): Promise<void> {
    while (!this.draining) {
      if (this.inflight.size >= this.opts.concurrency) { await sleep(this.opts.pollMs); continue; }
      const job = await claimJob(this.pool, this.opts.queueId, this.workerId, this.opts.leaseSeconds);
      if (!job) { await sleep(this.opts.pollMs); continue; }
      this.inflight.set(job.id, job.lease_token);
      const p = this.run(job.id, job.lease_token, job.payload);
      this.running.add(p);
      void p.finally(() => this.running.delete(p));
    }
  }

  private async run(jobId: number, token: number, payload: unknown): Promise<void> {
    await startJob(this.pool, jobId, token);
    const { execId, attempt } = await this.recordExecStart(jobId);
    await this.log(jobId, 'info', `running (attempt ${attempt}) on worker #${this.workerId}`);
    try {
      await this.opts.handler(payload);
      await completeJob(this.pool, jobId, token);
      await this.recordExecEnd(execId, 'COMPLETED', null);
      await this.log(jobId, 'info', 'completed');
    } catch (err) {
      await failJob(this.pool, jobId, token);
      await this.recordExecEnd(execId, 'FAILED', String(err));
      await this.log(jobId, 'error', `failed: ${String(err)}`);
      await retryOrDeadLetter(this.pool, jobId, String(err));   // retry with backoff, or DLQ at the cap
    } finally {
      this.inflight.delete(jobId);
    }
  }

  private async log(jobId: number, level: string, message: string): Promise<void> {
    await this.pool.query(`INSERT INTO job_logs(job_id, level, message) VALUES($1,$2,$3)`, [jobId, level, message]);
  }

  // Per-tick heartbeat: stamp liveness, log a beat, and renew the lease on every in-flight job (fenced).
  private async heartbeat(): Promise<void> {
    try {
      await this.pool.query(`UPDATE workers SET last_seen=now() WHERE id=$1`, [this.workerId]);
      await this.pool.query(`INSERT INTO worker_heartbeats(worker_id) VALUES($1)`, [this.workerId]);
      for (const [jobId, token] of this.inflight) {
        await heartbeatJob(this.pool, jobId, token, this.workerId, this.opts.leaseSeconds);
      }
    } catch { /* transient DB blip; next tick retries */ }
  }

  // Execution history + attempt counter (C25/C26/C29): one row per attempt.
  private async recordExecStart(jobId: number): Promise<{ execId: number; attempt: number }> {
    const a = await this.pool.query(
      `UPDATE jobs SET attempts = attempts + 1 WHERE id=$1 RETURNING attempts`, [jobId]);
    const attempt = a.rows[0].attempts;
    const r = await this.pool.query(
      `INSERT INTO job_executions(job_id, attempt, worker_id, status) VALUES($1,$2,$3,'RUNNING') RETURNING id`,
      [jobId, attempt, this.workerId]);
    return { execId: r.rows[0].id, attempt };
  }

  private async recordExecEnd(execId: number, status: string, error: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE job_executions SET status=$2, finished_at=now(), error=$3 WHERE id=$1`,
      [execId, status, error]);
  }
}

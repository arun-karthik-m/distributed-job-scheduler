// M5: REST API over everything built so far. Fastify gives schema validation (B2) and pino
// request logging (B7) out of the box; auth is JWT; every query is scoped to the caller's org (I9).
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import type pg from 'pg';
import cronParser from 'cron-parser';
import { hashPassword, verifyPassword } from './auth.ts';
import { enqueueImmediate, enqueueDelayed, enqueueScheduled, enqueueBatch, createSchedule } from './jobs.ts';
import { requeueFromDlq } from './retry.ts';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { userId: number; orgId: number };
    user: { userId: number; orgId: number };
  }
}
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

function paginate(q: unknown): { limit: number; offset: number } {
  const o = (q ?? {}) as Record<string, unknown>;
  const limit = Math.min(Math.max(Number(o.limit) || 20, 1), 100);
  const offset = Math.max(Number(o.offset) || 0, 0);
  return { limit, offset };
}

async function queueInOrg(pool: pg.Pool, queueId: number, orgId: number) {
  const r = await pool.query(
    `SELECT qu.id, qu.project_id, qu.name, qu.priority, qu.concurrency_limit, qu.status
     FROM queues qu JOIN projects p ON p.id = qu.project_id
     WHERE qu.id=$1 AND p.org_id=$2`, [queueId, orgId]);
  return r.rows[0] ?? null;
}

export function buildApp(pool: pg.Pool, opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false });
  app.register(fastifyJwt, { secret: process.env.JWT_SECRET ?? 'dev-secret-change-me' });

  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    try { await req.jwtVerify(); }
    catch { reply.code(401).send({ error: { code: 'unauthorized', message: 'invalid or missing token' } }); }
  });

  // One consistent error shape (B6). Validation failures arrive here as 400s.
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    const code = err.statusCode ?? 500;
    reply.code(code).send({ error: { code: err.code ?? 'error', message: err.message } });
  });

  const auth = { preHandler: [(req: FastifyRequest, reply: FastifyReply) => app.authenticate(req, reply)] };
  const creds = {
    body: {
      type: 'object', required: ['email', 'password'],
      properties: { email: { type: 'string', minLength: 3 }, password: { type: 'string', minLength: 6 } },
    },
  };

  // ---------- auth ----------
  app.post('/auth/register', { schema: creds }, async (req, reply) => {
    const { email, password } = req.body as { email: string; password: string };
    const org = await pool.query(`INSERT INTO organizations(name) VALUES($1) RETURNING id`, [`${email} org`]);
    const orgId = org.rows[0].id;
    try {
      const u = await pool.query(
        `INSERT INTO users(org_id,email,password_hash) VALUES($1,$2,$3) RETURNING id`,
        [orgId, email, hashPassword(password)]);
      return reply.code(201).send({ token: app.jwt.sign({ userId: u.rows[0].id, orgId }) });
    } catch {
      await pool.query(`DELETE FROM organizations WHERE id=$1`, [orgId]);   // roll back the orphan org
      return reply.code(409).send({ error: { code: 'email_taken', message: 'email already registered' } });
    }
  });

  app.post('/auth/login', { schema: creds }, async (req, reply) => {
    const { email, password } = req.body as { email: string; password: string };
    const u = await pool.query(`SELECT id, org_id, password_hash FROM users WHERE email=$1`, [email]);
    if (u.rowCount === 0 || !verifyPassword(password, u.rows[0].password_hash)) {
      return reply.code(401).send({ error: { code: 'bad_credentials', message: 'invalid email or password' } });
    }
    return { token: app.jwt.sign({ userId: u.rows[0].id, orgId: u.rows[0].org_id }) };
  });

  // ---------- projects ----------
  app.post('/projects', {
    ...auth,
    schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1 } } } },
  }, async (req, reply) => {
    const r = await pool.query(
      `INSERT INTO projects(org_id,name) VALUES($1,$2) RETURNING id,name,created_at`,
      [req.user.orgId, (req.body as { name: string }).name]);
    return reply.code(201).send(r.rows[0]);
  });

  app.get('/projects', auth, async (req) => {
    const { limit, offset } = paginate(req.query);
    const r = await pool.query(
      `SELECT id,name,created_at FROM projects WHERE org_id=$1 ORDER BY id LIMIT $2 OFFSET $3`,
      [req.user.orgId, limit, offset]);
    return { data: r.rows, limit, offset };
  });

  // ---------- queues ----------
  app.post('/projects/:projectId/queues', {
    ...auth,
    schema: {
      body: {
        type: 'object', required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
          priority: { type: 'integer' },
          concurrency_limit: { type: 'integer', minimum: 1 },
        },
      },
    },
  }, async (req, reply) => {
    const projectId = Number((req.params as { projectId: string }).projectId);
    const p = await pool.query(`SELECT 1 FROM projects WHERE id=$1 AND org_id=$2`, [projectId, req.user.orgId]);
    if (p.rowCount === 0) return reply.code(404).send({ error: { code: 'not_found', message: 'project not found' } });
    const b = req.body as { name: string; priority?: number; concurrency_limit?: number };
    const r = await pool.query(
      `INSERT INTO queues(project_id,name,priority,concurrency_limit)
       VALUES($1,$2,$3,$4) RETURNING id,name,priority,concurrency_limit,status`,
      [projectId, b.name, b.priority ?? 0, b.concurrency_limit ?? 10]);
    return reply.code(201).send(r.rows[0]);
  });

  app.get('/projects/:projectId/queues', auth, async (req, reply) => {
    const projectId = Number((req.params as { projectId: string }).projectId);
    const p = await pool.query(`SELECT 1 FROM projects WHERE id=$1 AND org_id=$2`, [projectId, req.user.orgId]);
    if (p.rowCount === 0) return reply.code(404).send({ error: { code: 'not_found', message: 'project not found' } });
    const r = await pool.query(
      `SELECT id,name,priority,concurrency_limit,status FROM queues WHERE project_id=$1 ORDER BY id`, [projectId]);
    return { data: r.rows };
  });

  app.get('/queues/:id', auth, async (req, reply) => {
    const q = await queueInOrg(pool, Number((req.params as { id: string }).id), req.user.orgId);
    if (!q) return reply.code(404).send({ error: { code: 'not_found', message: 'queue not found' } });
    return q;
  });

  // config update incl. pause/resume (status)
  app.patch('/queues/:id', {
    ...auth,
    schema: {
      body: {
        type: 'object',
        properties: {
          priority: { type: 'integer' },
          concurrency_limit: { type: 'integer', minimum: 1 },
          status: { type: 'string', enum: ['active', 'paused'] },
        },
      },
    },
  }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const q = await queueInOrg(pool, id, req.user.orgId);
    if (!q) return reply.code(404).send({ error: { code: 'not_found', message: 'queue not found' } });
    const b = req.body as { priority?: number; concurrency_limit?: number; status?: string };
    const r = await pool.query(
      `UPDATE queues SET priority=COALESCE($2,priority),
                         concurrency_limit=COALESCE($3,concurrency_limit),
                         status=COALESCE($4,status)
       WHERE id=$1 RETURNING id,name,priority,concurrency_limit,status`,
      [id, b.priority ?? null, b.concurrency_limit ?? null, b.status ?? null]);
    return r.rows[0];
  });

  app.get('/queues/:id/stats', auth, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const q = await queueInOrg(pool, id, req.user.orgId);
    if (!q) return reply.code(404).send({ error: { code: 'not_found', message: 'queue not found' } });
    const r = await pool.query(
      `SELECT status, count(*)::int AS n FROM jobs WHERE queue_id=$1 GROUP BY status`, [id]);
    const stats: Record<string, number> = {};
    for (const row of r.rows) stats[row.status] = row.n;
    return { queueId: id, stats };
  });

  // ---------- jobs ----------
  app.post('/queues/:id/jobs', {
    ...auth,
    schema: {
      body: {
        type: 'object', required: ['type'],
        properties: {
          type: { type: 'string', enum: ['immediate', 'delayed', 'scheduled', 'recurring', 'batch'] },
          payload: { type: 'object' },
          delaySeconds: { type: 'integer', minimum: 0 },
          runAt: { type: 'string' },
          cron: { type: 'string' },
          payloads: { type: 'array' },
        },
      },
    },
  }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const q = await queueInOrg(pool, id, req.user.orgId);
    if (!q) return reply.code(404).send({ error: { code: 'not_found', message: 'queue not found' } });
    const b = req.body as {
      type: string; payload?: unknown; delaySeconds?: number; runAt?: string; cron?: string; payloads?: unknown[];
    };
    const payload = b.payload ?? {};
    switch (b.type) {
      case 'immediate':
        return reply.code(201).send({ id: await enqueueImmediate(pool, q.project_id, q.id, payload) });
      case 'delayed':
        if (b.delaySeconds == null) return reply.code(400).send({ error: { code: 'bad_request', message: 'delaySeconds required' } });
        return reply.code(201).send({ id: await enqueueDelayed(pool, q.project_id, q.id, b.delaySeconds, payload) });
      case 'scheduled':
        if (!b.runAt) return reply.code(400).send({ error: { code: 'bad_request', message: 'runAt required' } });
        return reply.code(201).send({ id: await enqueueScheduled(pool, q.project_id, q.id, new Date(b.runAt), payload) });
      case 'batch':
        if (!b.payloads?.length) return reply.code(400).send({ error: { code: 'bad_request', message: 'payloads required' } });
        return reply.code(201).send({ ids: await enqueueBatch(pool, q.project_id, q.id, b.payloads) });
      case 'recurring': {
        if (!b.cron) return reply.code(400).send({ error: { code: 'bad_request', message: 'cron required' } });
        const next = cronParser.parseExpression(b.cron, { currentDate: new Date() }).next().toDate();
        return reply.code(201).send({ scheduleId: await createSchedule(pool, q.project_id, q.id, b.cron, next, payload) });
      }
      default:
        return reply.code(400).send({ error: { code: 'bad_request', message: 'unknown type' } });
    }
  });

  app.get('/queues/:id/jobs', auth, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const q = await queueInOrg(pool, id, req.user.orgId);
    if (!q) return reply.code(404).send({ error: { code: 'not_found', message: 'queue not found' } });
    const { limit, offset } = paginate(req.query);
    const status = (req.query as { status?: string }).status;
    const r = await pool.query(
      `SELECT id,type,status,priority,attempts,run_at,created_at FROM jobs
       WHERE queue_id=$1 AND ($2::job_status IS NULL OR status=$2)
       ORDER BY id DESC LIMIT $3 OFFSET $4`,
      [id, status ?? null, limit, offset]);
    return { data: r.rows, limit, offset };
  });

  app.get('/jobs/:id', auth, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const j = await pool.query(
      `SELECT j.* FROM jobs j JOIN projects p ON p.id=j.project_id WHERE j.id=$1 AND p.org_id=$2`,
      [id, req.user.orgId]);
    if (j.rowCount === 0) return reply.code(404).send({ error: { code: 'not_found', message: 'job not found' } });
    const ex = await pool.query(
      `SELECT attempt,worker_id,status,started_at,finished_at,error FROM job_executions WHERE job_id=$1 ORDER BY attempt`, [id]);
    const logs = await pool.query(
      `SELECT ts, level, message FROM job_logs WHERE job_id=$1 ORDER BY ts, id`, [id]);
    return { ...j.rows[0], executions: ex.rows, logs: logs.rows };
  });

  // manual retry / DLQ requeue (C33)
  app.post('/jobs/:id/retry', auth, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const j = await pool.query(
      `SELECT j.status FROM jobs j JOIN projects p ON p.id=j.project_id WHERE j.id=$1 AND p.org_id=$2`,
      [id, req.user.orgId]);
    if (j.rowCount === 0) return reply.code(404).send({ error: { code: 'not_found', message: 'job not found' } });
    if (j.rows[0].status === 'DLQ') { await requeueFromDlq(pool, id); return { requeued: true }; }
    if (j.rows[0].status === 'FAILED') {
      await pool.query(`UPDATE jobs SET status='QUEUED', worker_id=NULL, run_at=now() WHERE id=$1`, [id]);
      return { requeued: true };
    }
    return reply.code(409).send({ error: { code: 'not_retryable', message: `job is ${j.rows[0].status}` } });
  });

  app.get('/queues/:id/dlq', auth, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const q = await queueInOrg(pool, id, req.user.orgId);
    if (!q) return reply.code(404).send({ error: { code: 'not_found', message: 'queue not found' } });
    const r = await pool.query(
      `SELECT id,job_id,reason,attempts,failed_at FROM dead_letter_queue WHERE queue_id=$1 ORDER BY failed_at DESC`, [id]);
    return { data: r.rows };
  });

  // ---------- workers (C32) ----------
  app.get('/workers', auth, async () => {
    const r = await pool.query(
      `SELECT id, name, status, started_at, last_seen,
              (status='alive' AND last_seen > now() - interval '30 seconds') AS live
       FROM workers ORDER BY last_seen DESC LIMIT 100`);
    return { data: r.rows };
  });

  // ---------- throughput time-series (C34) ----------
  app.get('/metrics/throughput', auth, async (req) => {
    const r = await pool.query(
      `SELECT to_char(date_trunc('minute', je.finished_at), 'HH24:MI') AS t, count(*)::int AS n
       FROM job_executions je
       JOIN jobs j ON j.id = je.job_id
       JOIN projects p ON p.id = j.project_id
       WHERE p.org_id=$1 AND je.status='COMPLETED' AND je.finished_at > now() - interval '30 minutes'
       GROUP BY 1 ORDER BY 1`, [req.user.orgId]);
    return { data: r.rows };
  });

  // ---------- system metrics (observability, B7/C34) ----------
  app.get('/metrics', auth, async (req) => {
    const jobs = await pool.query(
      `SELECT status, count(*)::int AS n FROM jobs j JOIN projects p ON p.id=j.project_id
       WHERE p.org_id=$1 GROUP BY status`, [req.user.orgId]);
    const workers = await pool.query(
      `SELECT count(*)::int AS n FROM workers WHERE status='alive' AND last_seen > now() - interval '1 minute'`);
    const byStatus: Record<string, number> = {};
    for (const row of jobs.rows) byStatus[row.status] = row.n;
    return { jobs: byStatus, workersAlive: workers.rows[0].n };
  });

  return app;
}

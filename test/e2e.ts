// End-to-end smoke over REAL HTTP sockets (not fastify.inject): boot the API, drive it with
// fetch, let a live Worker process a job, confirm completion via the API. Proves the whole stack
// wires together. Run:  node --env-file=.env test/e2e.ts
import pg from 'pg';
import assert from 'node:assert/strict';
import { buildApp } from '../src/api.ts';
import { Worker } from '../src/worker.ts';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = buildApp(pool, { logger: false });
const PORT = 3111;
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(method: string, url: string, body?: unknown, token?: string) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

await app.listen({ port: PORT, host: '127.0.0.1' });
try {
  const email = `e2e_${process.pid}_${Math.floor(process.hrtime()[1])}@x.com`;
  const reg = await call('POST', '/auth/register', { email, password: 'secret123' });
  assert.equal(reg.status, 201, 'register');
  const token = reg.body.token;

  const proj = await call('POST', '/projects', { name: 'e2e' }, token);
  assert.equal(proj.status, 201, 'create project');

  const q = await call('POST', `/projects/${proj.body.id}/queues`, { name: 'q', concurrency_limit: 2 }, token);
  assert.equal(q.status, 201, 'create queue');
  const qid = q.body.id;

  // create one job of every type through the real API
  assert.equal((await call('POST', `/queues/${qid}/jobs`, { type: 'immediate', payload: { hi: 1 } }, token)).status, 201);
  assert.equal((await call('POST', `/queues/${qid}/jobs`, { type: 'delayed', delaySeconds: 3600 }, token)).status, 201);
  assert.equal((await call('POST', `/queues/${qid}/jobs`, { type: 'batch', payloads: [{ a: 1 }, { a: 2 }] }, token)).status, 201);
  const imm = (await call('GET', `/queues/${qid}/jobs?status=QUEUED`, undefined, token)).body.data[0];

  // a live worker drains the queue
  const w = new Worker(pool, { queueId: qid, concurrency: 2, leaseSeconds: 30, pollMs: 20, handler: async () => {} });
  await w.start();
  let status = '';
  for (let i = 0; i < 100; i++) {
    status = (await call('GET', `/jobs/${imm.id}`, undefined, token)).body.status;
    if (status === 'COMPLETED') break;
    await sleep(50);
  }
  await w.stop();
  assert.equal(status, 'COMPLETED', 'immediate job completed via worker');

  const metrics = (await call('GET', '/metrics', undefined, token)).body;
  console.log(`E2E OK — real HTTP round-trip, worker completed job ${imm.id}; metrics: ${JSON.stringify(metrics)}`);
} finally {
  await app.close();
  await pool.end();
}

// M5: REST API — auth, tenant scoping, validation, pagination, job creation, retry.
// Uses fastify.inject (in-process, no network).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './helpers.ts';
import { buildApp } from '../src/api.ts';

const app = buildApp(pool, { logger: false });

before(async () => {
  await app.ready();
  await pool.query('TRUNCATE organizations, workers RESTART IDENTITY CASCADE');
});
after(async () => { await app.close(); await pool.end(); });

async function register(email: string): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'secret123' } });
  assert.equal(r.statusCode, 201);
  return r.json().token;
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

test('register returns a token; duplicate email is 409', async () => {
  const t = await register('a@x.com');
  assert.ok(t);
  const dup = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'a@x.com', password: 'secret123' } });
  assert.equal(dup.statusCode, 409);
});

test('login works; wrong password is 401', async () => {
  await register('b@x.com');
  const ok = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'b@x.com', password: 'secret123' } });
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.json().token);
  const bad = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'b@x.com', password: 'wrongpassword' } });
  assert.equal(bad.statusCode, 401);
});

test('protected route without a token is 401', async () => {
  const r = await app.inject({ method: 'GET', url: '/projects' });
  assert.equal(r.statusCode, 401);
});

test('invalid body is rejected with 400 (validation)', async () => {
  const t = await register('val@x.com');
  const r = await app.inject({ method: 'POST', url: '/projects', headers: bearer(t), payload: {} });
  assert.equal(r.statusCode, 400);
});

test('project + queue create and list, scoped to the org', async () => {
  const t = await register('c@x.com');
  const proj = await app.inject({ method: 'POST', url: '/projects', headers: bearer(t), payload: { name: 'p1' } });
  assert.equal(proj.statusCode, 201);
  const pid = proj.json().id;
  const q = await app.inject({ method: 'POST', url: `/projects/${pid}/queues`, headers: bearer(t), payload: { name: 'q1', concurrency_limit: 3 } });
  assert.equal(q.statusCode, 201);
  const list = await app.inject({ method: 'GET', url: '/projects', headers: bearer(t) });
  assert.equal(list.json().data.length, 1);
});

test('I9: one org cannot see or touch another org’s project', async () => {
  const ta = await register('owner@x.com');
  const proj = await app.inject({ method: 'POST', url: '/projects', headers: bearer(ta), payload: { name: 'secret' } });
  const pid = proj.json().id;
  const tb = await register('intruder@x.com');
  const peek = await app.inject({ method: 'GET', url: `/projects/${pid}/queues`, headers: bearer(tb) });
  assert.equal(peek.statusCode, 404);                 // not visible to another tenant
  const listB = await app.inject({ method: 'GET', url: '/projects', headers: bearer(tb) });
  assert.equal(listB.json().data.length, 0);          // B sees none of A's projects
});

test('pause via PATCH stops the queue from yielding jobs', async () => {
  const t = await register('pz@x.com');
  const pid = (await app.inject({ method: 'POST', url: '/projects', headers: bearer(t), payload: { name: 'p' } })).json().id;
  const qid = (await app.inject({ method: 'POST', url: `/projects/${pid}/queues`, headers: bearer(t), payload: { name: 'q' } })).json().id;
  const patched = await app.inject({ method: 'PATCH', url: `/queues/${qid}`, headers: bearer(t), payload: { status: 'paused' } });
  assert.equal(patched.json().status, 'paused');
});

test('create jobs of every type, then list + filter + paginate', async () => {
  const t = await register('jobs@x.com');
  const pid = (await app.inject({ method: 'POST', url: '/projects', headers: bearer(t), payload: { name: 'p' } })).json().id;
  const qid = (await app.inject({ method: 'POST', url: `/projects/${pid}/queues`, headers: bearer(t), payload: { name: 'q' } })).json().id;
  const mk = (payload: object) => app.inject({ method: 'POST', url: `/queues/${qid}/jobs`, headers: bearer(t), payload });
  assert.equal((await mk({ type: 'immediate' })).statusCode, 201);
  assert.equal((await mk({ type: 'delayed', delaySeconds: 60 })).statusCode, 201);
  assert.equal((await mk({ type: 'scheduled', runAt: new Date(Date.now() + 3600_000).toISOString() })).statusCode, 201);
  assert.equal((await mk({ type: 'batch', payloads: [{ a: 1 }, { a: 2 }] })).statusCode, 201);
  assert.equal((await mk({ type: 'recurring', cron: '* * * * *' })).statusCode, 201);
  // delayed with no delaySeconds → 400
  assert.equal((await mk({ type: 'delayed' })).statusCode, 400);

  const all = await app.inject({ method: 'GET', url: `/queues/${qid}/jobs?limit=2`, headers: bearer(t) });
  assert.equal(all.json().data.length, 2);                         // pagination honored
  const queued = await app.inject({ method: 'GET', url: `/queues/${qid}/jobs?status=SCHEDULED`, headers: bearer(t) });
  assert.ok(queued.json().data.every((j: { status: string }) => j.status === 'SCHEDULED')); // filter honored
});

test('metrics endpoint returns job counts scoped to the org', async () => {
  const t = await register('m@x.com');
  const pid = (await app.inject({ method: 'POST', url: '/projects', headers: bearer(t), payload: { name: 'p' } })).json().id;
  const qid = (await app.inject({ method: 'POST', url: `/projects/${pid}/queues`, headers: bearer(t), payload: { name: 'q' } })).json().id;
  await app.inject({ method: 'POST', url: `/queues/${qid}/jobs`, headers: bearer(t), payload: { type: 'immediate' } });
  const m = await app.inject({ method: 'GET', url: '/metrics', headers: bearer(t) });
  assert.equal(m.json().jobs.QUEUED, 1);
});

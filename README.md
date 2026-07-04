# Distributed Job Scheduler

A Postgres-native distributed job scheduler. Design and the completeness ledger live in
`PLAN.md` and `ACCEPTANCE.md`. This README is the setup + verification path.

## Status
- **M0** — schema + DB-enforced state machine (illegal transitions rejected at the DB layer).
- **M1** — atomic claim + lease/fencing + concurrency limit + pause (invariants I1/I3/I8/I10/I11).
- **M2** — worker service: poll, concurrent execution, fenced heartbeat, graceful shutdown, execution history.
- **M3** — all 5 job types (immediate/delayed/scheduled/recurring-cron/batch) + scheduler process (promote due, materialize cron, reclaim leases). Run with `npm run scheduler`.
- **M4** — retry strategies (fixed/linear/exponential + cap) and Dead Letter Queue (terminal, inert, manual requeue only).
- **M5** — REST API (Fastify): auth (JWT + scrypt), projects, queues, jobs (all types), DLQ, metrics — with validation, pagination, filtering, tenant scoping, consistent errors. Run with `npm run api`.
- **M6** — React + Vite dashboard (`web/`): overview with a live job-lifecycle "state track", queues (create/pause/config), job explorer + filtering, DLQ requeue, workers, job detail with execution history, throughput sparkline. Polling live updates; accessibility-audited.
- **M7** — documentation: design decisions, architecture + ER diagrams, API reference (below).
- **34/34 backend tests green** + live end-to-end. Ledger: **70/71** `✓ Proven`. See `ACCEPTANCE.md`.

## Documentation
- [DECISIONS.md](DECISIONS.md) — 14 design decisions, each with its rejected alternative + Known Limitations
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system diagram, data flow, lifecycle state machine, invariants
- [docs/DATABASE.md](docs/DATABASE.md) — ER diagram + PK/FK/index/normalization/cascade/performance
- [docs/API.md](docs/API.md) — full REST endpoint reference
- [PLAN.md](PLAN.md) / [ACCEPTANCE.md](ACCEPTANCE.md) — the engineering plan and the frozen requirement ledger

## Run the whole system
```
npm run api                 # REST API on :3000 (terminal 1)
QUEUE_ID=<id> npm run worker # a worker (terminal 2)
npm run scheduler           # promotes scheduled/cron + reclaims leases (terminal 3)
cd web && npm install && npm run dev   # dashboard on :5173 (proxies /api → :3000)
```
Open http://localhost:5173, register, create a queue, enqueue jobs, and watch the worker drain them live.

## Setup

Postgres 17 required. Pick one:

**A — Docker (portable, one command):**
```
npm install
npm run db:up          # Postgres 17 in a container on :5433
cp .env.example .env
npm run migrate
npm test
```

**B — Local private cluster (no Docker, no admin, no password).** Uses the installed
Postgres 17 binaries to spin up a throwaway cluster on :5433, separate from any system service:
```
initdb -D .pgdata -U scheduler --auth=trust --auth-host=trust --encoding=UTF8
npm run pg:start       # start it (stop later with: npm run pg:stop)
createdb -h localhost -p 5433 -U scheduler scheduler
npm install
cp .env.example .env
npm run migrate
npm test
```

`.env` (`DATABASE_URL`) already points at `localhost:5433` for both paths.

## Verify M0
`npm test` should print 4 passing tests, including *"illegal transition QUEUED -> COMPLETED
is rejected at the DB layer"* — remove the trigger in `db/migrations/002_state_machine.sql`
and that test fails, which is the point (the test can falsify the claim).

## Layout
```
db/migrations/   ordered .sql — 001 schema, 002 state-machine trigger
db/migrate.ts    30-line runner (tracks applied files in schema_migrations)
test/            invariant falsification tests (node:test)
PLAN.md          design + invariant catalogue + hard SQL
ACCEPTANCE.md    frozen requirement ledger + definition of done
```

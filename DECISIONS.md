# Design Decisions

Every decision below is recorded with the alternative it was chosen over and where it lives in
code. The guiding rule: choose the simplest design that makes the hard invariants *provable*.

Delivery guarantee, stated honestly and never exceeded: **at-least-once execution + idempotency**,
never "exactly-once."

---

### 1. Postgres *is* the queue — no message broker
**Chose:** DB-native job claiming with row locks. **Over:** Redis/RabbitMQ/SQS as a separate broker.
**Why:** a broker adds infra and a second source of truth without buying a correctness property the
database doesn't already give us — `SELECT … FOR UPDATE SKIP LOCKED` is exactly atomic claiming, and
transactions give us the state machine, retries, and DLQ in one consistent store. Fewer moving parts,
every invariant provable in SQL. **Cost:** a single Postgres is the coordination point (see §12,
Limitations). **Code:** `src/claim.ts`.

### 2. Atomic claim = lock the queue row, count in a *separate* statement, then `SKIP LOCKED`
**Chose:** a 3-statement transaction — `SELECT concurrency_limit … FOR UPDATE` (queue row), then a
fresh `count(*)` of in-flight, then the claiming `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP
LOCKED LIMIT 1)`. **Over:** a single-statement CTE doing all three.
**Why (a bug we caught with a test, kept as evidence):** the single-statement version *looked*
correct — it locked the queue row — but under `READ COMMITTED` all CTEs in one statement share one
snapshot taken at statement start. A claimer that waited on the queue lock still counted in-flight
from its pre-wait snapshot and saw a stale zero: **14 claims passed a limit of 5** in
`test/claim.test.ts`. Counting in a separate statement *after* the lock gives a fresh snapshot that
sees peers' committed claims. **Trade-off:** claims on one queue serialize (see §10). **Code:**
`src/claim.ts` `claimJob`; **proof:** `test/claim.test.ts` I1/I10.

### 3. Lease + fencing token, not a boolean `is_alive`
**Chose:** each claim bumps a monotonic `lease_token`; completion/heartbeat are guarded by
`WHERE lease_token = $held`. **Over:** an `is_alive` flag.
**Why:** closes the "zombie worker" race — a worker that stalls past its lease, gets its job
reclaimed and reassigned, then wakes up and tries to complete, is fenced out (its token is stale,
`rowCount = 0`, it discards its result). A boolean can't distinguish the old holder from the new one.
**Code:** `src/claim.ts` `completeJob`/`heartbeatJob`; **proof:** `test/claim.test.ts` I3.

### 4. State machine enforced in the database, not just app code
**Chose:** a `BEFORE INSERT OR UPDATE OF status` trigger that rejects any transition not in the legal
set. **Over:** enforcing transitions only in TypeScript.
**Why:** enforcement beats intention — an illegal transition is rejected even via a raw `UPDATE`, so
the guarantee survives bugs, ad-hoc queries, and future code. **Code:** `db/migrations/002_state_machine.sql`;
**proof:** `test/state_machine.test.ts` (illegal `QUEUED→COMPLETED` rejected at the DB layer).

### 5. At-least-once + idempotency, never "exactly-once"
**Chose:** a job may run more than once under crash; effects are made idempotent via an
`idempotency_key`. **Over:** claiming exactly-once delivery.
**Why:** exactly-once delivery is impossible across a crash between "work done" and "status written";
honesty here is the highest-trust signal in the system. **Code:** `jobs.idempotency_key` (unique per
queue); reclaim path in `src/claim.ts` `reclaimExpired`.

### 6. Bounded retry with backoff → terminal, inert DLQ
**Chose:** fixed / linear / exponential backoff with a hard cap; on exhaustion the job moves to a
terminal `DLQ` state **and** a `dead_letter_queue` row; nothing auto-executes the DLQ — only an
explicit manual requeue moves a job out. **Over:** unbounded retry, or a "DLQ" nothing reads.
**Why:** unbounded retry turns one poison job into an infinite loop; a decorative DLQ hides failures.
**Code:** `src/retry.ts` `backoffSeconds`/`retryOrDeadLetter`/`requeueFromDlq`; **proof:**
`test/retry.test.ts` (I4 bounded, I5 inert, manual requeue).

### 7. Primary keys: `bigint` identity, not UUID  *(D13)*
**Chose:** `bigint GENERATED ALWAYS AS IDENTITY` on every table. **Over:** UUID PKs.
**Why:** the hot tables (`jobs`, `job_executions`, `job_logs`, `worker_heartbeats`) are append-heavy
and the claim index must stay dense; random UUIDs fragment that B-tree and bloat every FK. Where a
value must be externally meaningful we use a separate column (`jobs.idempotency_key`, unique), not
the PK. **Code:** `db/migrations/001_init.sql`.

### 8. 3NF with one deliberate denormalization  *(D16)*
**Chose:** entity tables in 3NF (retry policy is its own table referenced by queues, not copied per
job). The single denormalization: per-job counters (`attempts`, `status`) live on `jobs` so the
claim path reads one row instead of aggregating `job_executions`. **Over:** fully normalized (compute
attempts from executions every claim) or fully denormalized (copy policy onto each job).
**Why:** the claim is the hottest path; a single-row read there is worth one controlled redundancy.
**Code:** `db/migrations/001_init.sql`.

### 9. Cascade deletes down the ownership tree; `SET NULL` for worker refs  *(D14 / D17)*
**Chose:** `project → queue → job → {executions, logs, dlq}` all `ON DELETE CASCADE`; `worker_id`
references are `ON DELETE SET NULL`. **Over:** `RESTRICT` everywhere, or cascading through workers.
**Why:** deleting a project should cleanly remove its data, but deleting a *worker* must never
destroy job history — the execution record outlives the worker that ran it. **Code:** `001_init.sql`.

### 10. Per-queue claim serialization — accepted cost of a correct limit  *(D18)*
**Chose:** the queue-row `FOR UPDATE` lock serializes all claimers on the *same* queue. **Over:** a
lock-free claim that can overshoot the limit (§2).
**Why:** a per-queue concurrency limit is a global constraint over that queue, so its check-and-claim
must serialize somewhere; this is inherent, not incidental. Different queues never contend. **Upgrade
path if a single hot queue ever needs more claim throughput:** a per-queue advisory lock or a
maintained counter column. Not built — unjustified at this scale. **Code:** `src/claim.ts`.

### 11. Single active scheduler; safe under restart, not "HA"
**Chose:** one scheduler process running idempotent sweeps (`promoteDue`, `materializeCron`,
`reclaimExpired`); due rows read `FOR UPDATE SKIP LOCKED`. **Over:** claiming multi-instance HA.
**Why:** the SKIP-LOCKED guard means a crash, restart, or an accidental second instance can never
skip or double-fire an occurrence — that's the verifiable claim. Genuine leader-election HA is out of
scope and would be overclaiming. **Code:** `src/scheduler.ts`.

### 12. Process-level separation (API / scheduler / worker), not microservices
**Chose:** three process types sharing one database. **Over:** a microservice split with its own
network boundaries.
**Why:** the separation we need is *operational* (scale workers independently, isolate the scheduler)
— it doesn't require network boundaries or per-service datastores, which would add failure modes
without a correctness benefit. **Code:** `src/api-main.ts`, `src/scheduler-main.ts`, `src/worker-main.ts`.

### 13. Stack: Node + TypeScript, Fastify, raw SQL, scrypt, plain-SQL migrations
- **Raw SQL over an ORM** — the claiming/fencing logic *is* the project; an ORM would obscure the
  exact SQL that has to be correct. `pg` only.
- **Fastify** — built-in JSON-schema validation (B2) and pino request logging (B7) with no extra deps.
- **scrypt (Node stdlib) over bcrypt** — no dependency for password hashing. `src/auth.ts`.
- **A 30-line SQL migration runner over a framework** — ordered `.sql` files are the most
  reviewer-transparent artifact for a DB-graded project. `db/migrate.ts`.
- **React + Vite + polling** — polling (not WebSockets) is enough for an ops dashboard and far
  simpler; WebSockets are listed as a bonus, not built.

### 14. Tenant scoping on every query  *(I9)*
**Chose:** every project/queue/job query is filtered by the JWT's `org_id` (joined through
`projects.org_id`). **Over:** trusting resource IDs from the client.
**Why:** cheap, provable isolation — one org cannot read or mutate another's data. **Code:** `src/api.ts`
(`queueInOrg`, `org_id` in every WHERE); **proof:** `test/api.test.ts` I9.

---

## Known Limitations (what we did *not* build, and why)

- **Workers are not tenant-scoped.** The `workers`/`worker_heartbeats` tables have no `org_id` — a
  worker is shared infrastructure that can serve any queue. Consequence: the Workers page and the
  `workersAlive` metric are **global**, while job metrics are per-org, so a freshly-registered org
  can see "3 workers alive" next to "0 jobs." Defensible (a worker pool is infra), but not fully
  multi-tenant. Scoping workers to orgs would need an `org_id` column and per-org worker pools.
- **At-least-once, not exactly-once** — by design (§5). A crash between execution and the completion
  write causes a re-run; idempotency keys absorb it.
- **Single Postgres is a single point of failure / coordination bottleneck.** No replication or
  distributed consensus (§1). Correct at assignment scale; not HA.
- **Per-queue claim throughput is serialized** (§10) — fine for many queues, a ceiling for one very
  hot queue.
- **Cron uses skip-missed semantics** — if the scheduler is down past several occurrences, missed
  ones are skipped (next fire computed from `now()`), not replayed in a burst.
- **DLQ requeue resets the attempt budget** — a manually requeued job gets a fresh set of retries.
- **The dashboard has no automated tests** — the backend does (34 tests + a live E2E); the frontend
  was verified by build + live smoke + an accessibility audit, not by unit tests.
- **Not built (bonus scope):** rate limiting, RBAC, queue sharding, workflow dependencies,
  event-driven execution, WebSocket live updates, AI failure summaries.

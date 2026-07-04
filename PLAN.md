# Distributed Job Scheduler — Operating Plan (v3)

This replaces the prior EOS document. That document was 9 parts of governance about
governance with zero object-level engineering in it, and it mis-weighted effort toward a
15-point rubric category while deprioritizing 50 points of DB/Backend/Frontend. This
version is the whole plan. If something isn't here, it isn't a rule.

---

## 0. Architecture (System Architecture — 20 marks, tied-highest; put it first)

**Three processes, one Postgres as the coordination substrate.** No message broker, no
external lock service — the database *is* the queue, and row-level locking *is* the
coordination primitive. This is the central architectural decision; its rejected
alternative (Redis/RabbitMQ broker) is recorded in DECISIONS.md, rejected because a broker
adds infra without buying a correctness property the DB doesn't already give us (§4).

```
        ┌──────────┐   REST/JWT    ┌───────────────────────────┐
 client │   API    │──────────────▶│         Postgres          │◀────┐
        │ process  │  reads/writes │  jobs · queues · leases   │     │
        └──────────┘               │  executions · logs · DLQ  │     │
                                   └───────────────────────────┘     │
        ┌──────────┐  promote due / spawn cron / reclaim leases      │
        │scheduler │─────────────────────────────────────────────────┘
        │ process  │  (single logical role; safe to run 1 instance)  │
        └──────────┘                                                 │
        ┌──────────┐  poll → SKIP-LOCKED claim → execute → heartbeat │
 workers│  worker  │─────────────────────────────────────────────────┘
        │ processes│  (N instances, horizontally scaled, stateless)
        └──────────┘
```

**Component responsibilities (each is a claim a reviewer can check against code):**
- **API** — auth, project/queue/job CRUD, pagination/filtering, error model, request logging.
  Stateless; owns no scheduling logic.
- **Scheduler** — the one component the old plan left undefined. Runs three periodic sweeps:
  (a) promote `SCHEDULED`/delayed jobs to `QUEUED` when `run_at <= now()` (I8); (b) on a
  recurring job's completion, materialize the next occurrence from its cron expression (§4);
  (c) reclaim expired leases (I7). **Single active instance (HA out of scope).** Sweeps read
  due rows with `FOR UPDATE SKIP LOCKED`, so a crash-and-restart — or an accidental second
  instance — can never skip or double-fire; that's the verifiable claim, not "HA works."
- **Worker** — poll → atomic claim (I1) → execute concurrently up to the queue's concurrency
  limit (I10) → heartbeat (extends lease) → complete with fencing (I3) → graceful drain on
  SIGTERM. N stateless instances; this is what "distributed across multiple workers" means.

**Data flow:** create (API) → SCHEDULED/QUEUED → scheduler promotes → worker claims → RUNNING
→ COMPLETED, or FAILED → {retry backoff → QUEUED | exhausted → DLQ}. One diagram, matches code.

---

## 1. Operating core (the only governance — internalize this, don't re-read)

**7 principles**
1. Failure is the default case, not the exception.
2. Every claim must be verifiable by a reviewer in under a minute.
3. One falsified claim costs more than ten unverified claims help.
4. Depth on the smallest set of hard invariants beats breadth across features — **but only
   after the rubric's required breadth is covered** (see §2).
5. Every artifact traces to one decision, or it doesn't exist.
6. Demonstration beats description — a passing test outranks a paragraph.
7. When time is scarce, spend it on what earns the most marks per hour, not on what's most
   intellectually satisfying.

**Three-way binding (the only quality gate that runs constantly):** every claim in docs
maps to code, and to a test or a stated limitation. No exceptions.

**DECISIONS.md format (one line per decision):**
`YYYY-MM-DD | <decision> | chose <X> over <Y> because <invariant/reason>`

**Pre-submission checklist (run once, at the end):** every invariant has a passing test ·
every README/DECISIONS claim verified against code · fresh-clone setup works end-to-end ·
DLQ never auto-executes · ER + arch diagrams match code · limitations section is honest ·
no secrets, no dead code · dashboard loads and shows live data.

That's the entire process. No per-commit ceremony, no decision matrix, no per-phase AI
protocol. If a genuine fork appears (two plausible designs), score correctness-under-failure
first, then verifiability, then marks-per-hour. Otherwise just build.

---

## 2. Scope, aligned to the actual rubric (not to a minimalism doctrine)

Rubric: Architecture 20 · **DB 20 · Backend 20** · Reliability & Concurrency 15 ·
**Frontend 10** · API 5 · Docs 5 · Testing 5.

The brief's **Core Requirements are Core** — including the ones the old plan risked cutting.
These earn Backend/DB marks and are non-negotiable:

- **Job types — ALL of them are Core:** immediate, delayed, scheduled, recurring (cron),
  batch. (The old plan risked filing these as "Optional." They're named in the brief.)
- Queue config: priority, concurrency limit, retry policy, pause/resume, stats. **Core.**
- Auth + projects/orgs + queues owned by projects. **Core.**
- Worker: poll → atomic claim → concurrent execute → heartbeat → graceful shutdown. **Core.**
- Lifecycle: Queued→Scheduled→Claimed→Running→Completed, retries, DLQ. **Core.**
- Retry strategies: fixed / linear / exponential backoff, with cap. **Core.**
- Execution logs, retry history, worker assignment, timestamps, metrics per job. **Core.**
- **Observability** (named in the grading rationale + Backend Expectations' "logging"):
  structured request/worker logs with a correlation id, plus a `/metrics`-style counters
  endpoint the dashboard reads. Distinct from per-job `job_logs`; both exist. **Core.**
- Manual actions the dashboard needs a backend for: **retry a FAILED job** (before DLQ) and
  **requeue from DLQ** — two endpoints, both named in the brief's dashboard requirement. **Core.**
- **Dashboard: queue health, worker status, job explorer, logs, config, throughput/metrics.
  Core — it is 10 marks, double Docs/Testing/API. Build it, don't default it off.**

**Bonus (build only if Core is done AND tested, in this order of marks-per-hour):**
RBAC → WebSocket live updates → rate limiting → workflow dependencies → distributed locking
→ queue sharding → event-driven execution → AI failure summaries. Everything below RBAC is
unlikely to be reached; that's fine, state so honestly.

**Guarantee stated honestly, everywhere:** *at-least-once delivery + idempotent execution.*
Never "exactly-once." This is the highest-trust signal in the whole submission.

---

## 3. The invariant catalogue (the load-bearing artifact — this is what everything traces to)

Each invariant names its enforcement mechanism and its test. This is the section the old
document referenced ten times and never wrote.

| # | Invariant | Enforced by | Test that could fail |
|---|-----------|-------------|----------------------|
| I1 | A QUEUED job is claimed by **at most one** worker | `FOR UPDATE SKIP LOCKED` in one txn (§4) | N workers race one job → exactly 1 wins |
| I2 | Only **legal state transitions** occur | trigger on `jobs.status` (§4) | raw `UPDATE` to illegal state is rejected |
| I3 | A worker may complete only a job it **still holds** | fencing token check on completion (§4) | zombie worker's completion after reassignment is a no-op |
| I4 | Retries are **bounded**; exhaustion → DLQ | `attempts >= max_attempts` check before requeue | job failing forever lands in DLQ, stops retrying |
| I5 | DLQ is **terminal and inert** | no scheduler path reads DLQ; only manual requeue | DLQ entry never auto-executes |
| I6 | Crash mid-run ⇒ job **re-runs at-least-once**; effects **idempotent** | lease expiry reclaim + idempotency key | kill worker mid-job → job completes exactly once in effect |
| I7 | Expired leases are **reclaimed** | scheduler requeues where `lease_expires_at < now()` | crashed worker's job returns to QUEUED |
| I8 | Delayed/scheduled jobs are **invisible until due** | claim filters `run_at <= now()` | future job is never claimed early |
| I9 | Every query is **tenant-scoped** | `project_id` in every WHERE + FK | project A cannot read project B's jobs |
| I10 | A queue never exceeds its **concurrency limit** | claim counts in-flight jobs in the same txn (§4) | flood 100 jobs, limit=5 → never >5 RUNNING at once |
| I11 | A **paused** queue yields no jobs | claim filters `queue.status = 'active'` (§4) | pause queue → in-flight finish, nothing new starts |

I10 and I11 were absent from v2 — both are named Core queue config, and I10 in particular
is a genuine concurrency invariant (not a config toggle) that belongs in the R&C category.

---

## 4. The hard mechanics (write these first — they are the submission)

**Atomic claim (I1, I8, I10, I11) — a short transaction: lock → fresh count → claim.**
Three statements in one transaction, NOT one CTE statement (see the correctness note below):
```sql
BEGIN;
-- 1. lock the queue row: serializes every claimer on this queue; paused/missing → nothing (I11)
SELECT concurrency_limit FROM queues WHERE id = $1 AND status = 'active' FOR UPDATE;
-- 2. count in-flight in a SEPARATE statement — a fresh READ COMMITTED snapshot sees peers'
--    committed claims (I10). If count >= limit: ROLLBACK and return null.
SELECT count(*) FROM jobs WHERE queue_id = $1 AND status IN ('CLAIMED','RUNNING');
-- 3. claim one due job: SKIP LOCKED exclusivity (I1), run_at gate (I8), priority order, token bump (I3)
UPDATE jobs SET status='CLAIMED', worker_id=$2, lease_token=lease_token+1,
    lease_expires_at = now() + make_interval(secs => $3), claimed_at = now()
WHERE id = (SELECT id FROM jobs
            WHERE queue_id=$1 AND status='QUEUED' AND run_at <= now()
            ORDER BY priority DESC, run_at ASC
            FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING id, lease_token, payload;
COMMIT;
```
**Correctness note — a claim this plan got wrong, then a test caught (kept as evidence).** An
earlier version did all of this in ONE statement, with the count as a CTE beside `... FOR UPDATE`
on the queue row. That is wrong: under READ COMMITTED every CTE in a single statement shares one
snapshot taken at statement start, so a claimer that *waits* on the queue lock still counts
in-flight from its pre-wait snapshot and sees a stale zero — **14 claims passed a limit of 5** in
`test/claim.test.ts`. The fix is to count in a **separate statement after the lock**: a new
statement takes a new snapshot that sees the committed claims. Per-queue serialization is the
honest cost of a per-queue limit (Known Limitations). Implemented in `src/claim.ts`; proven by the
I1/I3/I10/I11 tests, which run green 3× consecutively with no flakiness.

**Completion with fencing (I3) — a stale worker cannot overwrite a reassigned job:**
```sql
UPDATE jobs
SET status = 'COMPLETED', completed_at = now(), result = $3
WHERE id = $1 AND lease_token = $2 AND status = 'RUNNING';
-- rows_affected = 0  ⇒  lease was lost/reassigned; worker discards its result and stops.
```

**Lease reclaim (I6, I7) — scheduler sweep, returns dead workers' jobs to the pool:**
```sql
UPDATE jobs
SET status = 'QUEUED', worker_id = NULL, run_at = now()
WHERE status IN ('CLAIMED','RUNNING') AND lease_expires_at < now();
-- lease_token is NOT reset; next claim bumps it, fencing out the old holder (I3).
```

**Heartbeat (C17) — extends the lease, but only for the job the worker still holds (fenced):**
```sql
UPDATE jobs SET lease_expires_at = now() + $3::interval
WHERE id = $1 AND lease_token = $2 AND worker_id = $4 AND status = 'RUNNING';
-- rows_affected = 0 ⇒ job was reclaimed/reassigned; worker stops working it (same guard as completion).
-- Also stamp workers.last_seen = now() for the liveness view (I7 reclaim reads jobs.lease_expires_at,
-- not this — worker liveness and job leases are tracked separately).
```

**State machine (I2) — Postgres CHECK can't express transitions, so use a trigger.**
State it honestly as a trigger, not a CHECK constraint. Legal edges:
`QUEUED→CLAIMED→RUNNING→{COMPLETED,FAILED}`, `FAILED→QUEUED` (retry, if attempts left),
`FAILED→DLQ` (exhausted), `SCHEDULED→QUEUED` (due), `{CLAIMED,RUNNING}→QUEUED` (reclaim).
The trigger raises on any edge not in this set — so an illegal raw `UPDATE` is rejected at
the DB layer, which is the reviewer-visible signal for I2. (Naming note: the brief writes the
lifecycle "Queued → Scheduled → Claimed"; our model treats SCHEDULED as the pre-QUEUED state
for future-dated jobs — `SCHEDULED→QUEUED→CLAIMED`. Call this out in docs so it doesn't read
as a mismatch; the ordering difference is deliberate and more correct.)

**Idempotency (I6):** each job carries an `idempotency_key`; the handler records completed
keys and no-ops on replay. This is what makes "at-least-once" safe — say exactly that.

**Job-type mechanics (Backend 20 — defined, not hand-waved):**
- *immediate* → inserted `QUEUED, run_at = now()`.
- *delayed* → `QUEUED, run_at = now() + delay`; claim's `run_at <= now()` (I8) hides it until due.
- *scheduled* → `SCHEDULED, run_at = <timestamp>`; scheduler promotes to `QUEUED` at `run_at`.
- *recurring (cron)* → row in `scheduled_jobs` holds the cron expr + `next_run_at`. Scheduler,
  on firing, selects due rows `WHERE next_run_at <= now() FOR UPDATE SKIP LOCKED`, then enqueues
  one occurrence **and** advances `next_run_at` in the same transaction — so a crash, restart, or
  second scheduler never skips or double-spawns an occurrence.
- *batch* → one API call creates N sibling jobs sharing a `batch_id`; each is an independent
  claimable row (no partial-batch atomicity claimed — stated as a limitation, not hidden).

---

## 5. Schema (12 tables from the brief, every index justified by a query or invariant)

`organizations`, `users`, `projects`, `queues`, `jobs`, `job_executions`, `retry_policies`,
`workers`, `worker_heartbeats`, `job_logs`, `scheduled_jobs`, `dead_letter_queue`.

The brief asks to *explain* PKs, FKs, indexes, normalization, cascades, performance — so
DECISIONS.md must cover all six, not just indexes:
- **Primary keys:** `bigint` identity for the hot `jobs`/`job_executions`/`job_logs` tables
  (index locality on the append-heavy claim path) — chosen over UUID, which fragments the
  B-tree on the one index that must stay hot. UUID only where a PK is client-supplied or
  externally exposed (e.g. `idempotency_key` is a separate unique column, not the PK).
- **Normalization:** 3NF for the entity tables (retry policy is its own table referenced by
  queues, not copied per job). One deliberate denormalization: per-job counters (`attempts`,
  `last_status`) live on `jobs` for a single-row claim read instead of an aggregate over
  `job_executions` — recorded as a decision with its rejected alternative.

Index rules — each index maps to a named access path, nothing "for future flexibility":
- `jobs (queue_id, status, priority DESC, run_at)` — the claim query (I1/I8). **The** hot path.
- `jobs (lease_expires_at) WHERE status IN ('CLAIMED','RUNNING')` — partial, for reclaim (I7).
- `jobs (project_id, ...)` on every list endpoint — tenant scoping (I9) + job explorer.
- `job_executions (job_id, started_at)` — retry history / execution timeline.
- `worker_heartbeats (worker_id, ts)` — append-only beat history; liveness reads `workers.last_seen`
  (stamped per beat), so this table is prunable. Retention: keep 24h, delete older in the reclaim sweep.
- FKs: `ON DELETE CASCADE` from project→queue→job; `RESTRICT` on anything a DLQ entry
  references (don't cascade-delete audit trail). Document each cascade choice in DECISIONS.md.

---

## 6. Milestones — dashboard spiked EARLY, ordering relaxed where it derisks marks

The old plan's strict waterfall pushed the 10-point frontend and the docs to the final
hours, where under-budgeted work dies. Fixed: a thin dashboard spike goes in at ~hour 12,
right after the API skeleton exists, then gets fleshed out in parallel.

| # | Milestone | Marks served | Hrs | Done when |
|---|-----------|--------------|-----|-----------|
| M0 | Schema + migrations + state-machine trigger (I2) | DB 20 | 6 | illegal raw UPDATE rejected |
| M1 | Atomic claim + lease + fencing + limit + pause (I1,I3,I10,I11) | R&C 15 | 5 | N-workers-1-job → 1 wins; flood N≫limit → peak RUNNING ≤ limit; paused queue yields nothing |
| M2 | Worker: poll/execute concurrently/heartbeat/graceful shutdown | Backend, R&C | 4 | SIGTERM drains in-flight, no orphans |
| M3 | Job types: immediate/delayed/scheduled/cron/recurring/batch | Backend 20 | 4 | each type demonstrably fires |
| M4 | Retry (fixed/linear/exp + cap) + DLQ terminal (I4,I5) | R&C, Backend | 3 | exhausted job in DLQ, inert |
| M5 | REST API: auth, projects, queues (config + pause/resume), jobs, retry/requeue actions, pagination, filtering, error model, structured logging | Backend/API | 4 | consistent errors, tenant-scoped (I9), paused queue stops |
| **M6** | **Dashboard (responsive, polling for live updates) — thin spike at hr ~12, then queue health/worker/job explorer/logs/metrics** | **Frontend 10** | 5 | live data renders, throughput chart, retry button works |
| M7 | Docs: DECISIONS.md, ER + arch diagram, API docs, honest limitations | Docs 5 | 2 | every claim traces to code |
| — | Reclaim sweep (I7) + idempotency (I6) + crash test | R&C 15 | 2 | kill-mid-job test → one effect |

~35h. Rule: M0→M1 are strictly ordered (retry/DLQ depend on claim/lease being correct).
After M1, order flexes — spike the dashboard as soon as any endpoint returns data, so the
10-point frontend isn't hostage to the last two hours.

---

## 7. What you are NOT building, stated plainly (omission without explanation reads as ignorance)

Not built: exactly-once delivery (impossible; we do at-least-once + idempotent) · distributed
consensus / external lock service (single-Postgres claiming suffices at this scale) · queue
sharding, event-driven execution, AI summaries (bonus, out of time budget) · enterprise auth
(JWT + project scoping only). Each of these goes in the README's Known Limitations with the
one-line reason. That honesty is worth more marks than a half-built version of any of them.

-- 001_init.sql — full relational schema for the 12 brief entities (ledger D1–D12).
--
-- Primary keys: bigint IDENTITY everywhere. Rationale (DECISIONS D13): the hot tables
-- (jobs, job_executions, job_logs, worker_heartbeats) are append-heavy and the claim index
-- must stay dense; random UUIDs fragment that B-tree. idempotency_key is a separate UNIQUE
-- column, never the PK.
-- Foreign keys / cascades (D14/D17): project owns queues/jobs → ON DELETE CASCADE. Worker
-- references are ON DELETE SET NULL so deleting a worker never destroys job history.

CREATE TYPE job_type       AS ENUM ('immediate','delayed','scheduled','recurring','batch');
CREATE TYPE job_status     AS ENUM ('QUEUED','SCHEDULED','CLAIMED','RUNNING','COMPLETED','FAILED','DLQ');
CREATE TYPE queue_status   AS ENUM ('active','paused');
CREATE TYPE retry_strategy AS ENUM ('fixed','linear','exponential');
CREATE TYPE worker_status  AS ENUM ('alive','draining','dead');

CREATE TABLE organizations (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Retry policy is its own table (3NF, D16) — referenced by queues, never copied per job.
CREATE TABLE retry_policies (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id   bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         text NOT NULL,
  strategy     retry_strategy NOT NULL DEFAULT 'exponential',
  base_delay_s integer NOT NULL DEFAULT 5  CHECK (base_delay_s >= 0),
  max_attempts integer NOT NULL DEFAULT 5  CHECK (max_attempts >= 1),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE queues (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id        bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name              text NOT NULL,
  priority          integer NOT NULL DEFAULT 0,
  concurrency_limit integer NOT NULL DEFAULT 10 CHECK (concurrency_limit >= 1),
  status            queue_status NOT NULL DEFAULT 'active',
  retry_policy_id   bigint REFERENCES retry_policies(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE workers (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,
  status     worker_status NOT NULL DEFAULT 'alive',
  last_seen  timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id       bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE, -- denormalized for I9 tenant scoping
  queue_id         bigint NOT NULL REFERENCES queues(id)   ON DELETE CASCADE,
  type             job_type   NOT NULL,
  status           job_status NOT NULL DEFAULT 'QUEUED',
  priority         integer    NOT NULL DEFAULT 0,
  payload          jsonb      NOT NULL DEFAULT '{}',
  idempotency_key  text,
  run_at           timestamptz NOT NULL DEFAULT now(),
  -- lease / fencing (I3, I7)
  worker_id        bigint REFERENCES workers(id) ON DELETE SET NULL,
  lease_token      bigint NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  -- retry counters denormalized onto the row for a single-row claim read (DECISIONS D16/D18)
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 5,
  batch_id         bigint,
  created_at       timestamptz NOT NULL DEFAULT now(),
  claimed_at       timestamptz,
  completed_at     timestamptz,
  UNIQUE (queue_id, idempotency_key)   -- NULLs allowed → non-idempotent jobs are unconstrained
);

CREATE TABLE job_executions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id      bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt     integer NOT NULL,
  worker_id   bigint REFERENCES workers(id) ON DELETE SET NULL,
  status      job_status NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error       text
);

CREATE TABLE job_logs (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id  bigint NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ts      timestamptz NOT NULL DEFAULT now(),
  level   text NOT NULL DEFAULT 'info',
  message text NOT NULL
);

CREATE TABLE worker_heartbeats (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  worker_id bigint NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  ts        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scheduled_jobs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id  bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  queue_id    bigint NOT NULL REFERENCES queues(id)   ON DELETE CASCADE,
  cron_expr   text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  next_run_at timestamptz NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dead_letter_queue (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id     bigint NOT NULL REFERENCES jobs(id)     ON DELETE CASCADE,
  queue_id   bigint NOT NULL REFERENCES queues(id)   ON DELETE CASCADE,
  project_id bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  reason     text,
  attempts   integer NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  failed_at  timestamptz NOT NULL DEFAULT now()
);

-- Indexes (D15) — each maps to a named access path in PLAN §5, nothing speculative.
CREATE INDEX jobs_claim_idx     ON jobs (queue_id, status, priority DESC, run_at);              -- claim hot path (I1/I8)
CREATE INDEX jobs_reclaim_idx   ON jobs (lease_expires_at) WHERE status IN ('CLAIMED','RUNNING'); -- reclaim sweep (I7)
CREATE INDEX jobs_project_idx   ON jobs (project_id, status);                                    -- tenant-scoped lists (I9)
CREATE INDEX jobs_batch_idx     ON jobs (batch_id) WHERE batch_id IS NOT NULL;                   -- batch inspection
CREATE INDEX job_exec_job_idx   ON job_executions (job_id, started_at);                          -- retry history
CREATE INDEX job_logs_job_idx   ON job_logs (job_id, ts);                                        -- per-job log view
CREATE INDEX heartbeat_idx      ON worker_heartbeats (worker_id, ts);                            -- liveness history
CREATE INDEX scheduled_due_idx  ON scheduled_jobs (next_run_at) WHERE active;                    -- scheduler due-scan
CREATE INDEX dlq_project_idx    ON dead_letter_queue (project_id, failed_at);                    -- DLQ browse

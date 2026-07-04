# API Reference

Base URL: `http://localhost:3000` (the dashboard reaches it as `/api/*` via the Vite proxy).
Source: [`src/api.ts`](../src/api.ts).

## Conventions
- **Auth:** all routes except `/auth/*` require `Authorization: Bearer <jwt>`. Tokens come from
  register/login and carry `{ userId, orgId }`; every resource is scoped to the caller's org.
- **Errors:** one shape everywhere — `{ "error": { "code": "…", "message": "…" } }`. Schema-validation
  failures return `400`; missing/invalid token `401`; cross-tenant or unknown resource `404`.
- **Pagination:** `?limit=<1..100, default 20>&offset=<default 0>`; list responses include
  `{ data, limit, offset }`.

## Auth
| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| POST | `/auth/register` | `{email, password≥6}` | `201 {token}` (creates a new org + owner) | `409` email taken, `400` invalid |
| POST | `/auth/login` | `{email, password}` | `200 {token}` | `401` bad credentials |

## Projects
| Method | Path | Body | Success |
|---|---|---|---|
| POST | `/projects` | `{name}` | `201 {id,name,created_at}` |
| GET | `/projects` | — | `200 {data:[{id,name,created_at}], limit, offset}` |

## Queues
| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| POST | `/projects/:projectId/queues` | `{name, priority?, concurrency_limit?}` | `201 {id,name,priority,concurrency_limit,status}` | `404` project |
| GET | `/projects/:projectId/queues` | — | `200 {data:[queue]}` | `404` |
| GET | `/queues/:id` | — | `200 queue` | `404` |
| PATCH | `/queues/:id` | `{priority?, concurrency_limit?, status?}` | `200 queue` — `status` ∈ `active\|paused` (pause/resume) | `404` |
| GET | `/queues/:id/stats` | — | `200 {queueId, stats:{STATE:count}}` | `404` |

## Jobs
Create — one endpoint, dispatched by `type`:

| `type` | extra body | creates |
|---|---|---|
| `immediate` | — | `201 {id}` — runnable now |
| `delayed` | `delaySeconds` | `201 {id}` — hidden until due |
| `scheduled` | `runAt` (ISO) | `201 {id}` — promoted by the scheduler at `runAt` |
| `recurring` | `cron` (5-field) | `201 {scheduleId}` — scheduler materializes each occurrence |
| `batch` | `payloads: []` | `201 {ids:[…]}` — N siblings sharing a `batch_id` |

All accept an optional `payload` object. Missing type-specific fields → `400`.

| Method | Path | Query | Success | Errors |
|---|---|---|---|---|
| POST | `/queues/:id/jobs` | — | see table above | `400`, `404` |
| GET | `/queues/:id/jobs` | `?status=&limit=&offset=` | `200 {data:[job], limit, offset}` | `404` |
| GET | `/jobs/:id` | — | `200 {…job, executions:[…]}` | `404` |
| POST | `/jobs/:id/retry` | — | `200 {requeued:true}` — requeues a `FAILED` or `DLQ` job | `404`, `409` not retryable |
| GET | `/queues/:id/dlq` | — | `200 {data:[{id,job_id,reason,attempts,failed_at}]}` | `404` |

## Workers & metrics
| Method | Path | Success |
|---|---|---|
| GET | `/workers` | `200 {data:[{id,name,status,started_at,last_seen,live}]}` (global — see limitations) |
| GET | `/metrics` | `200 {jobs:{STATE:count}, workersAlive}` (jobs org-scoped) |
| GET | `/metrics/throughput` | `200 {data:[{t:"HH:MM", n}]}` — completions/min, last 30 min |

## Example

```bash
TOKEN=$(curl -s localhost:3000/auth/register -d '{"email":"a@b.c","password":"secret123"}' \
  -H 'content-type: application/json' | jq -r .token)
PID=$(curl -s localhost:3000/projects -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"notifications"}' | jq -r .id)
QID=$(curl -s localhost:3000/projects/$PID/queues -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"emails","concurrency_limit":5}' | jq -r .id)
curl -s localhost:3000/queues/$QID/jobs -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"type":"immediate","payload":{"to":"x@y.z"}}'
```

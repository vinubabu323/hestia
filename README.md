# Hestia

### The hearth that keeps your jobs running.

A lightweight distributed job scheduler built as a zero-new-infrastructure alternative to Temporal. It targets teams already running PostgreSQL and Redis who need cron reliability without operating a separate cluster.

> **Why this exists:** Most teams solve distributed cron by running it on a single isolated server. It works until that server crashes, gets deployed, or runs two jobs simultaneously. This project focuses on leader election, retry guarantees, and job visibility without adding Kafka, a separate database, or any new infrastructure beyond what you already have.

## Architecture

### Client / SDK
- TypeScript SDK plus REST and WebSocket clients provide tenant-aware job configuration, live status, and audit trail notifications.
- The client layer talks to the Management API for job and tenant management and listens for updates pushed over WebSocket or gRPC streams.

### Management API (NestJS + Prisma)
- Handles job CRUD, tenant configuration, rate limits, RBAC, and exposes REST, WebSocket, and gRPC endpoints for both the UI or CLI and the scheduler.
- Maintains tenant metadata, job schemas, and prepares payloads for the scheduler while keeping PostgreSQL as the single source of truth.

### Scheduler Core (Go)
- Leader election and cron ticking live here. Redis locks plus PostgreSQL event logs ensure a single scheduler instance dispatches jobs, and retries follow a defined state machine.
- Dispatches jobs over gRPC to workers, tracks idempotency keys, and writes every state transition into PostgreSQL for visibility and auditing.

### Workers
- Go worker - handles HTTP webhooks and shell commands.
- NestJS worker - performs transactional database work, notifications, and integrations.
- Python worker - runs data scripts and long-running payloads that benefit from the Python ecosystem.
- Each worker type reports execution status back to the scheduler over gRPC so locks are released and success or failure is recorded in the event log.

### Data and Coordination
- PostgreSQL is the primary store for jobs, tenants, and the event log. Schema migrations live alongside the Management API and scheduler.
- Redis is used strictly for coordination: leader election locks, job locks, and idempotency keys. Durable state stays in PostgreSQL so restarts do not lose data.
- Observability sits on top with Prometheus metrics and OpenTelemetry traces so a single trace can span API entry, scheduler dispatch, worker execution, and event log writes.

## How It Works

### Leader Election
Multiple scheduler instances can run simultaneously. Only one becomes the leader and fires cron ticks. Redis `SET key NX PX <ttl>` gives leadership to the first instance that acquires the lock. If the leader stops renewing the TTL, another instance can take over automatically within seconds.

### Job Dispatch
On every cron tick, the leader queries PostgreSQL for jobs due to run. Before executing, it acquires a per-job distributed lock in Redis together with an idempotency key so duplicate execution is avoided even during a brief split-brain window.

### Retry State Machine
Each job follows a simple flow: `PENDING -> RUNNING -> SUCCESS` or `FAILED -> RETRYING`. Failures use exponential backoff with jitter. The max retry count is configurable per job. Every state transition is written to the PostgreSQL event log with timestamp, duration, attempt number, and failure reason.

### Worker Pool
Workers are separate services that receive dispatched jobs over gRPC. Each worker type handles a different job category:
- **Go worker** - HTTP webhook calls and shell command execution
- **NestJS worker** - database operations and notification delivery
- **Python worker** - script execution and data processing tasks

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Management API | NestJS + Prisma | REST, WebSocket, and gRPC server |
| Scheduler core | Go | Goroutines for concurrent dispatch with minimal overhead |
| Workers | Go / NestJS / Python | Each language fits its job type |
| Primary store | PostgreSQL | Jobs, tenants, and event log without new infrastructure |
| Coordination | Redis | Leader election and distributed locks only |
| Observability | Prometheus + OpenTelemetry | Metrics and distributed traces |
| Local dev | Docker Compose | One-command startup |
| Deployment | Railway | Managed deployment target |

## Project Structure

| Path | Purpose |
|---|---|
| `management-api/` | NestJS API for jobs, tenants, auth, and realtime endpoints |
| `scheduler/` | Go scheduler for leader election, cron ticking, dispatch, and retries |
| `workers/` | Language-specific worker services |
| `sdk/` | TypeScript client SDK |
| `proto/` | gRPC contract definitions |
| `docker-compose.yml` | Local orchestration entry point |
| `README.md` | Product overview and setup guide |

## Getting Started

### Prerequisites
- Docker Engine with Docker Compose support
- Go 1.21 or newer
- Node.js 20 or newer
- Python 3.11 or newer

### Environment variables

| Variable | Purpose | Example | Required | Verification |
|---|---|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string used by the Management API, scheduler, and workers. | `postgresql://user:pass@localhost:5432/hestia_dev` | Yes | `npx prisma migrate deploy` succeeds |
| `REDIS_URL` | Redis endpoint for leader election, job locks, and idempotency keys. | `redis://localhost:6379/0` | Yes | Scheduler connects during `docker compose up` |
| `GRPC_PORT` | Port exposed by the scheduler for worker traffic and metrics. | `4000` | Yes | `http://localhost:4000/metrics` responds |
| `JWT_SECRET` | Shared secret for signing and validating Management API tokens. | `replace-with-secure-secret` | Yes | API starts without auth config errors |
| `WEBHOOK_SECRET` | Secret used to sign outgoing webhook notifications. | `webhook-shared-secret` | Optional | Webhook worker can generate signatures |
| `WEBHOOK_TOKEN` | Token used when downstream webhook endpoints require bearer auth. | `replace-with-webhook-token` | Optional | Outbound webhook test includes expected auth header |
| `NODE_ENV` | Controls local versus production logging and defaults. | `development` | Optional | Service logs show expected environment |

### Migrations and seeding
1. Run Prisma migrations from the Management API workspace:
   ```bash
   cd management-api
   npx prisma migrate deploy
   ```
2. Seed a default tenant, user, and sample job definition:
   ```bash
   npx prisma db seed
   ```
3. Build the scheduler to confirm the Go services compile against the current schema:
   ```bash
   cd ../scheduler
   go build ./cmd/...
   ```
4. Optionally run Go tests for an extra schema and integration sanity check:
   ```bash
   go test ./...
   ```

### Local development
1. Clone the repository and enter the project directory:
   ```bash
   git clone https://github.com/vinubabu/hestia
   cd hestia
   ```
2. Copy the checked-in env template and adjust any local values that differ:
   ```bash
   cp .env.example .env
   ```
3. Start PostgreSQL, Redis, the API, scheduler, and workers:
   ```bash
   docker compose up
   ```
4. Confirm the main local endpoints:
   - Management API: `http://localhost:3000`
   - Scheduler metrics: `http://localhost:4000/metrics`
   - Grafana: `http://localhost:3001`

### Getting Started verification checklist
1. Clone the repo and prepare `.env` with `DATABASE_URL`, `REDIS_URL`, `GRPC_PORT`, and `JWT_SECRET`.
2. Run `npx prisma migrate deploy` from `management-api`.
3. Run `npx prisma db seed` from `management-api`.
4. Run `go build ./cmd/...` from `scheduler`.
5. Start `docker compose up` and wait for all services to report healthy startup logs.
6. Visit `http://localhost:3000` and confirm the Management API responds.
7. Visit `http://localhost:4000/metrics` and confirm Prometheus metrics are exposed.
8. Create a sample tenant and job, then confirm the scheduler writes an event log entry.

### Troubleshooting
- **Missing environment variables:** services exit early with config validation errors. Inspect `docker compose logs management-api`, `docker compose logs scheduler`, or the relevant worker logs.
- **Migrations not applied:** Prisma reports migration drift or missing tables. Re-run `npx prisma migrate deploy` before restarting containers.
- **Ports already in use:** Docker reports bind failures for `3000`, `3001`, or `4000`. Stop the conflicting process or remap the port in Compose.
- **Redis or PostgreSQL unreachable:** containers loop on reconnect attempts. Verify hostnames, credentials, and exposed ports in `.env` and Compose config.
- **Worker dispatch failures:** scheduler logs show gRPC or lock errors and jobs remain pending or retrying. Inspect scheduler logs first, then the specific worker container.

### Seed a first tenant and job
Use the API to create a sample tenant and a job after the stack is running:

```bash
curl -X POST http://localhost:3000/tenants \
  -H "Content-Type: application/json" \
  -d '{"name":"acme-corp"}'

curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -d '{"name":"send-invoice","cron":"0 9 * * *","tenantId":"acme-corp","retries":3}'
```

### Schedule your first job with the SDK

```typescript
import { Scheduler } from '@vinubabu/hestia-sdk'

const scheduler = new Scheduler({ url: 'http://localhost:3000' })

await scheduler.define('send-invoice', async (payload) => {
  console.log('Sending invoice for', payload.tenantId)
})

await scheduler.schedule('send-invoice', '0 9 * * *', {
  tenantId: 'acme-corp',
  retries: 3,
})
```

## API Reference

### Jobs

Required headers for all job endpoints:
- `Authorization: Bearer <jwt>`
- `X-Tenant-ID: <tenant-id>`
- `Idempotency-Key: <uuid>` for create or reschedule requests

#### `POST /jobs`
Creates a job definition for the tenant carried by the token and header.

Request body:

```json
{
  "name": "send-invoice",
  "cron": "0 9 * * *",
  "payload": {
    "tenantId": "acme-corp",
    "template": "invoice-reminder"
  },
  "maxRetries": 3,
  "retryBackoffSeconds": 60
}
```

Response `201 Created`:

```json
{
  "id": "job_01HV8J3M8P6A6R5T9K1Q",
  "tenantId": "acme-corp",
  "name": "send-invoice",
  "cron": "0 9 * * *",
  "payload": {
    "tenantId": "acme-corp",
    "template": "invoice-reminder"
  },
  "maxRetries": 3,
  "status": "ACTIVE",
  "createdAt": "2026-04-14T16:20:00Z"
}
```

Expected status codes:
- `201` when the job is created
- `400` for invalid cron, missing payload, or `maxRetries` outside the allowed range
- `401` when the bearer token is missing or invalid
- `403` when the token tenant or role does not permit the action
- `409` when the idempotency key has already been used with a different payload
- `429` when tenant rate limits reject the request

#### `GET /jobs`
Lists jobs for the authenticated tenant.

Query parameters:
- `page` - 1-based page number, default `1`
- `limit` - page size, default `20`, max `100`
- `status` - optional filter such as `ACTIVE`, `PAUSED`, or `FAILED`

Response `200 OK`:

```json
{
  "items": [
    {
      "id": "job_01HV8J3M8P6A6R5T9K1Q",
      "name": "send-invoice",
      "cron": "0 9 * * *",
      "status": "ACTIVE",
      "nextRunAt": "2026-04-15T09:00:00Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

Expected status codes: `200`, `401`, `403`, `429`

#### `GET /jobs/:id`
Returns the full job definition for a single tenant-scoped job.

Response `200 OK`:

```json
{
  "id": "job_01HV8J3M8P6A6R5T9K1Q",
  "tenantId": "acme-corp",
  "name": "send-invoice",
  "cron": "0 9 * * *",
  "payload": {
    "tenantId": "acme-corp",
    "template": "invoice-reminder"
  },
  "maxRetries": 3,
  "status": "ACTIVE",
  "nextRunAt": "2026-04-15T09:00:00Z"
}
```

Expected status codes: `200`, `401`, `403`, `404`, `429`

#### `PATCH /jobs/:id`
Updates mutable job fields such as cron, payload, and retry policy.

Request body:

```json
{
  "cron": "*/15 * * * *",
  "payload": {
    "tenantId": "acme-corp",
    "template": "invoice-reminder",
    "priority": "high"
  },
  "maxRetries": 5
}
```

Response `200 OK`:

```json
{
  "id": "job_01HV8J3M8P6A6R5T9K1Q",
  "cron": "*/15 * * * *",
  "maxRetries": 5,
  "updatedAt": "2026-04-14T16:45:00Z"
}
```

Expected status codes: `200`, `400`, `401`, `403`, `404`, `409`, `429`

#### `DELETE /jobs/:id`
Deletes a tenant-scoped job definition.

Response `200 OK`:

```json
{
  "id": "job_01HV8J3M8P6A6R5T9K1Q",
  "deleted": true
}
```

Expected status codes: `200`, `401`, `403`, `404`, `429`

#### `GET /jobs/:id/history`
Returns execution history for a single job.

Query parameters:
- `page` - 1-based page number, default `1`
- `limit` - page size, default `20`, max `100`

Response `200 OK`:

```json
{
  "items": [
    {
      "attempt": 1,
      "status": "SUCCESS",
      "startedAt": "2026-04-14T09:00:00Z",
      "finishedAt": "2026-04-14T09:00:03Z",
      "durationMs": 3000,
      "worker": "go-worker"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1
}
```

Expected status codes: `200`, `401`, `403`, `404`, `429`

### Tenants

Required headers for tenant endpoints:
- `Authorization: Bearer <jwt>`
- `X-Tenant-ID: <tenant-id>` for tenant-scoped reads and updates

#### `POST /tenants`
Creates a tenant. This endpoint is intended for admin tokens only.

Request body:

```json
{
  "name": "acme-corp",
  "slug": "acme-corp",
  "rateLimitPerMinute": 120
}
```

Response `201 Created`:

```json
{
  "id": "tenant_01HV8J1PXJTXM9E3J7NC",
  "name": "acme-corp",
  "slug": "acme-corp",
  "rateLimitPerMinute": 120,
  "createdAt": "2026-04-14T16:10:00Z"
}
```

Expected status codes: `201`, `400`, `401`, `403`, `409`

#### `GET /tenants/:id`
Returns tenant configuration and limits for the tenant in scope.

Response `200 OK`:

```json
{
  "id": "tenant_01HV8J1PXJTXM9E3J7NC",
  "name": "acme-corp",
  "slug": "acme-corp",
  "rateLimitPerMinute": 120,
  "roles": ["admin", "scheduler"]
}
```

Expected status codes: `200`, `401`, `403`, `404`

#### `PATCH /tenants/:id`
Updates tenant-level configuration such as rate limits and webhook defaults.

Request body:

```json
{
  "rateLimitPerMinute": 90,
  "webhook": {
    "url": "https://example.com/hestia-events",
    "signingSecretRef": "WEBHOOK_SECRET"
  }
}
```

Response `200 OK`:

```json
{
  "id": "tenant_01HV8J1PXJTXM9E3J7NC",
  "rateLimitPerMinute": 90,
  "updatedAt": "2026-04-14T16:30:00Z"
}
```

Expected status codes: `200`, `400`, `401`, `403`, `404`, `429`

### Validation, RBAC, and error shapes

- Tenant isolation is enforced twice: the `Authorization` token carries tenant claims, and `X-Tenant-ID` must match those claims on every tenant-scoped request.
- Cross-tenant access returns `403 Forbidden` with a stable `tenant_mismatch` code.
- Recommended roles:
  - `admin` - full job and tenant management
  - `scheduler` - create, update, and inspect jobs, but no tenant-wide admin changes
  - `viewer` - read-only access to jobs and history
- Job definitions should reject invalid cron expressions, missing payload objects, and retry policies that exceed service limits.
- Re-scheduling and create flows should require an `Idempotency-Key` so clients can safely retry after timeouts.
- SDK and CLI behavior should mirror server validation: reject malformed cron strings, invalid JSON payloads, and tokens missing the expected tenant claims before sending the request.

Sample tenant mismatch error:

```json
{
  "error": {
    "code": "tenant_mismatch",
    "message": "Token tenant does not match X-Tenant-ID",
    "status": 403
  }
}
```

Sample validation error:

```json
{
  "error": {
    "code": "validation_error",
    "message": "cron must be a valid expression",
    "status": 400,
    "details": {
      "field": "cron"
    }
  }
}
```

Sample rate limit error:

```json
{
  "error": {
    "code": "rate_limited",
    "message": "Tenant request limit exceeded",
    "status": 429
  }
}
```

### Manual verification

```bash
curl -X POST http://localhost:3000/jobs \
  -H "Authorization: Bearer <jwt>" \
  -H "X-Tenant-ID: acme-corp" \
  -H "Idempotency-Key: 4c8d9d34-f0b9-4c09-a7f0-d3f84f2bc84c" \
  -H "Content-Type: application/json" \
  -d '{"name":"send-invoice","cron":"0 9 * * *","payload":{"tenantId":"acme-corp"},"maxRetries":3}'
```

Verify that:
- the response includes a job `id`
- repeating the same request with the same idempotency key does not create a duplicate job
- sending `X-Tenant-ID: other-tenant` returns the documented `tenant_mismatch` error
- sending an invalid cron string returns the documented validation error

## Key Design Decisions

**PostgreSQL as event log, not Kafka**
Kafka adds operational complexity that contradicts the core constraint of zero new infrastructure. PostgreSQL with proper indexing on `(tenant_id, started_at)` handles thousands of job events per minute without issue. At the scale this targets, Kafka is unnecessary.

**gRPC for scheduler-to-worker dispatch, not a message queue**
Job execution requires acknowledgement. The scheduler needs to know whether a worker accepted the job before releasing the distributed lock. Synchronous gRPC provides a clear contract.

**Redis only for coordination, not storage**
Redis handles two things: leader election locks and per-job distributed locks. All durable state lives in PostgreSQL. Redis can be flushed or restarted without data loss because the scheduler rebuilds state from PostgreSQL.

**Why not Temporal?**
Temporal is excellent for complex workflow orchestration. Hestia targets a simpler use case: teams that have outgrown a single cron server but are not ready to operate a full Temporal cluster with its own database and visibility service. If you need workflow DAGs or long-running sagas, use Temporal. If you need reliable distributed cron on your existing stack, use Hestia.

## Observability

Prometheus metrics exposed at `/metrics` on the Go scheduler:
- `scheduler_jobs_dispatched_total` - counter by tenant and job type
- `scheduler_job_duration_seconds` - histogram of execution time
- `scheduler_leader_elections_total` - leadership changes
- `scheduler_retry_attempts_total` - retry volume by job type

OpenTelemetry traces span across all services. A single trace shows the full lifecycle of a job from dispatch through worker execution to event log write.

## Roadmap

- [ ] Web UI for job management dashboard
- [ ] Job dependency chains (run B after A succeeds)
- [ ] Rate limiting per tenant
- [ ] Webhook notifications on job completion
- [ ] CLI for local job testing

## License

MIT

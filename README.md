# Hestia

### The hearth that keeps your jobs running.

A lightweight distributed job scheduler built as a zero-new-infrastructure alternative to Temporal — targets teams running PostgreSQL and Redis who need cron reliability without operating a separate cluster.

> **Why this exists:** Most teams solve distributed cron by running it on a single isolated server. It works until that server crashes, gets deployed, or runs two jobs simultaneously. This project solves leader election, retry guarantees, and job visibility without adding Kafka, a separate database, or any new infrastructure beyond what you already have.

## Architecture

```
┌─────────────────────────────────────────┐
│              Client / SDK               │
│         TypeScript · REST · WebSocket   │
└────────────────┬────────────────────────┘
                 │
┌────────────────▼────────────────────────┐
│         Management API (NestJS)         │
│   Job CRUD · Tenant config · RBAC       │
│   WebSocket push · gRPC server          │
└──────┬─────────────┬────────────────────┘
       │             │
┌──────▼──────┐ ┌────▼──────────┐ ┌───────────────┐
│    Redis    │ │  PostgreSQL   │ │  gRPC server  │
│ Leader lock │ │ Jobs · Tenants│ │ Config sync   │
│ Job locks   │ │ Event log     │ │ to scheduler  │
└─────────────┘ └───────────────┘ └───────┬───────┘
                                          │
                 ┌────────────────────────▼────────┐
                 │      Scheduler Core (Go)         │
                 │  Leader election · Cron tick     │
                 │  Job dispatch · Retry FSM        │
                 │  Idempotency keys                │
                 └──────┬──────────────────────────┘
                        │
        ┌───────────────┼───────────────┐
        │               │               │
┌───────▼──────┐ ┌──────▼──────┐ ┌─────▼────────┐
│  Go Worker   │ │NestJS Worker│ │Python Worker │
│ HTTP · Shell │ │ DB · Notify │ │Scripts · Data│
└───────┬──────┘ └──────┬──────┘ └─────┬────────┘
        └───────────────┼───────────────┘
                        │
        ┌───────────────▼───────────────┐
        │      PostgreSQL Event Log     │
        │ job_id · status · duration    │
        │ attempt · error · tenant_id   │
        └───────────────────────────────┘
                        │
        ┌───────────────▼───────────────┐
        │         Observability         │
        │   Prometheus · OpenTelemetry  │
        │   Grafana dashboard           │
        └───────────────────────────────┘
```

## How It Works

### Leader Election
Multiple scheduler instances can run simultaneously. Only one becomes the leader and fires cron ticks. Uses Redis `SET NX PX` — the first instance to acquire the key becomes leader. The key has a TTL; if the leader crashes, the TTL expires and another instance takes over automatically within seconds.

### Job Dispatch
On every cron tick, the leader queries PostgreSQL for jobs due to run. Before executing, it acquires a per-job distributed lock in Redis with an idempotency key — preventing duplicate execution even if two instances briefly think they're leader (split-brain window).

### Retry State Machine
Each job tracks: `PENDING → RUNNING → SUCCESS | FAILED → RETRYING`. On failure, exponential backoff with jitter is applied. Max retry count is configurable per job. Every state transition is written to the PostgreSQL event log with timestamp, duration, attempt number, and failure reason.

### Worker Pool
Workers are separate services that receive dispatched jobs over gRPC. Each worker type handles a different job category:
- **Go worker** — HTTP webhook calls, shell command execution
- **NestJS worker** — database operations, notification delivery
- **Python worker** — script execution, data processing tasks

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Management API | NestJS + Prisma | REST, WebSocket, gRPC server |
| Scheduler core | Go | Goroutines for concurrent dispatch, minimal overhead |
| Workers | Go · NestJS · Python | Each language suited to its job type |
| Primary store | PostgreSQL | Jobs, tenants, event log — no new infra |
| Coordination | Redis | Leader election + distributed locks only |
| Observability | Prometheus + OpenTelemetry | Metrics and distributed traces |
| Local dev | Docker Compose | One command startup |
| Deployment | Railway | Live URL, zero infra management |

## Project Structure

```
/
├── management-api/        # NestJS — job CRUD, tenant config, RBAC
│   ├── src/
│   │   ├── jobs/
│   │   ├── tenants/
│   │   ├── auth/
│   │   └── gateway/       # WebSocket
│   └── Dockerfile
│
├── scheduler/             # Go — leader election, cron tick, dispatch
│   ├── cmd/
│   ├── internal/
│   │   ├── election/      # Redis SETNX leader election
│   │   ├── ticker/        # Cron tick engine
│   │   ├── dispatch/      # Job dispatcher
│   │   └── retry/         # Retry state machine
│   └── Dockerfile
│
├── workers/
│   ├── go-worker/         # HTTP and shell jobs
│   ├── nestjs-worker/     # DB and notification jobs
│   └── python-worker/     # Script and data jobs
│
├── sdk/                   # TypeScript client SDK
│   └── src/
│
├── proto/                 # gRPC proto definitions
│   └── scheduler.proto
│
├── docker-compose.yml     # Local development
└── README.md
```

## Getting Started

### Prerequisites
- Docker and Docker Compose
- Go 1.21+
- Node.js 20+
- Python 3.11+

### Local Development

```bash
# Clone the repo
git clone https://github.com/vinubabu/hestia
cd hestia

# Start all services
docker-compose up

# Management API: http://localhost:3000
# Scheduler:      http://localhost:4000
# Grafana:        http://localhost:3001
```

### Schedule Your First Job

```typescript
import { Scheduler } from '@vinubabu/hestia-sdk'

const scheduler = new Scheduler({ url: 'http://localhost:3000' })

// Define a job handler
await scheduler.define('send-invoice', async (payload) => {
  console.log('Sending invoice for', payload.tenantId)
})

// Schedule it
await scheduler.schedule('send-invoice', '0 9 * * *', {
  tenantId: 'acme-corp',
  retries: 3,
})
```

## API Reference

### Jobs

```
POST   /jobs              Create a job definition
GET    /jobs              List all jobs
GET    /jobs/:id          Get job details
PATCH  /jobs/:id          Update job schedule or config
DELETE /jobs/:id          Delete a job

GET    /jobs/:id/history  Full execution history
```

### Tenants

```
POST   /tenants           Create a tenant
GET    /tenants/:id       Get tenant config
PATCH  /tenants/:id       Update rate limits and config
```

## Key Design Decisions

**PostgreSQL as event log, not Kafka**
Kafka adds operational complexity that contradicts the core constraint of zero new infrastructure. PostgreSQL with proper indexing on `(tenant_id, started_at)` handles thousands of job events per minute without issue. At the scale this targets, Kafka is overengineered.

**gRPC for scheduler-to-worker dispatch, not a message queue**
Job execution requires acknowledgement — the scheduler needs to know if a worker accepted the job before releasing the distributed lock. Fire-and-forget async semantics would make retry logic ambiguous. Synchronous gRPC gives a clear contract.

**Redis only for coordination, not storage**
Redis handles two things: leader election locks and per-job distributed locks. All durable state lives in PostgreSQL. This means Redis can be flushed or restarted without data loss — the scheduler recovers cleanly from PostgreSQL state.

**Why not Temporal?**
Temporal is excellent for complex workflow orchestration. This project targets a simpler use case: teams who've outgrown a single cron server but aren't ready to operate a full Temporal cluster with its own database and visibility service. If you need workflow DAGs or long-running sagas, use Temporal. If you need reliable distributed cron on your existing stack, use this.

## Observability

Prometheus metrics exposed at `/metrics` on the Go scheduler:
- `scheduler_jobs_dispatched_total` — counter by tenant and job type
- `scheduler_job_duration_seconds` — histogram of execution time
- `scheduler_leader_elections_total` — how often leadership changes
- `scheduler_retry_attempts_total` — retry volume by job type

OpenTelemetry traces span across all services — a single trace shows the full lifecycle of a job from dispatch through worker execution to event log write.

## Roadmap

- [ ] Web UI for job management dashboard
- [ ] Job dependency chains (run B after A succeeds)
- [ ] Rate limiting per tenant
- [ ] Webhook notifications on job completion
- [ ] CLI for local job testing

## License

MIT

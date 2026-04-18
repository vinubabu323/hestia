# Sprint-by-sprint action plan for README/roadmap doc

## Summary
- Purpose: Document the README fixes, documentation expansion, and roadmap execution across four sprints so the next engineer can implement without ambiguity.
- Location: This file lives at `plan/README-plan.md` and is referenced whenever documentation or roadmap work is scheduled.
- Ownership: Assign a doc reviewer to validate every checklist item before marking a sprint complete.

## Sprint 1 deliverables

| Deliverable | Description | Owner | Validation |
|---|---|---|---|
| Updated README sections | Rework architecture, setup, prerequisites, migrations, and Getting Started sections into UTF-8-safe Markdown. | Docs engineer | Reviewer confirms rendered Markdown is readable and setup steps are complete. |
| Verification checklist | Add an explicit startup and troubleshooting checklist covering env vars, migrations, services, ports, and health endpoints. | Docs engineer | Reviewer walks the checklist and marks each item green or records a blocking gap. |
| Sprint 1 plan entry | Keep this file current with mojibake inventory, replacement guidance, and README line references for the reorganized sections. | Docs engineer | Reviewer confirms this file matches the README structure after edits. |

## Sprint 1 - README hygiene & setup

### 1. Plan artifact status
- Confirmed: `plan/README-plan.md` exists and is now the source of truth for Sprint 1 deliverables, replacement notes, and hand-off criteria.
- Sprint 1 output is complete only when the README and this plan stay aligned after review.

### 2. Encoding and diagram cleanup inventory

| README area | Broken text observed | UTF-8-safe replacement | Notes |
|---|---|---|---|
| Intro paragraph | `Temporal â€”`, stray escaped newlines | Replace mojibake punctuation with plain ASCII or proper UTF-8 punctuation and remove escaped newline text. | Use ASCII where possible to avoid future encoding regressions. |
| Retry state machine | `PENDING â†’ RUNNING â†’ SUCCESS | FAILED â†’ RETRYING` | `PENDING -> RUNNING -> SUCCESS` and `FAILED -> RETRYING` in plain text. | Avoid directional glyphs in critical setup docs. |
| Worker list | `Go worker â€”`, `NestJS worker â€”`, `Python worker â€”` | `Go worker -`, `NestJS worker -`, `Python worker -` | Keeps rendering stable in terminals and GitHub. |
| Tech stack table | `Go Â· NestJS Â· Python`, `event log â€” no new infra` | `Go / NestJS / Python`, `event log - no new infra` | Replace mixed mojibake separators with plain ASCII. |
| Project structure tree | `â”œâ”€â”€`, `â”‚`, `â””â”€â”€` | Replace with a plain Markdown table describing directories and responsibilities. | Safer than box-drawing characters if editors keep changing encodings. |
| Failure modes | `binding errorsâ€”either` | `binding errors - either` | Keep punctuation consistent. |
| Observability bullets | `â€”` in metric descriptions | `-` in metric descriptions | Reduces copy/paste surprises in terminals. |

Rendered example that replaces the corrupted project tree block:

| Path | Purpose |
|---|---|
| `management-api/` | NestJS API for jobs, tenants, auth, and realtime endpoints |
| `scheduler/` | Go scheduler for leader election, ticking, dispatch, and retries |
| `workers/` | Language-specific worker services |
| `sdk/` | TypeScript SDK |
| `proto/` | gRPC contract definitions |
| `docker-compose.yml` | Local orchestration entry point |

### 3. Prerequisites inventory to capture in README

| Item | Required value or version | Setup command / expectation | Verification |
|---|---|---|---|
| Docker Engine | Current stable release with Compose support | `docker compose version` | Command succeeds and Compose is available. |
| Go | `1.21+` | Install Go toolchain before building scheduler or worker code. | `go version` reports `1.21` or newer. |
| Node.js | `20+` | Needed for NestJS services, Prisma, and SDK tooling. | `node -v` reports `20.x` or newer. |
| Python | `3.11+` | Needed for Python worker jobs. | `python --version` reports `3.11` or newer. |
| `DATABASE_URL` | PostgreSQL connection string | Export in `.env` before running API or scheduler. | `npx prisma migrate deploy` succeeds. |
| `REDIS_URL` | Redis connection string | Export in `.env` before starting scheduler. | Redis connection succeeds during `docker compose up`. |
| `GRPC_PORT` | Scheduler gRPC and metrics port, default `4000` | Export in `.env` and keep port free locally. | `http://localhost:4000/metrics` responds after startup. |
| `JWT_SECRET` | Shared secret for Management API auth | Export in `.env`; keep non-default in shared environments. | API boots without auth config errors. |
| `WEBHOOK_SECRET` | Secret for signing webhook deliveries | Export when webhook worker behavior is enabled. | Webhook jobs can compute signatures without config errors. |
| `WEBHOOK_TOKEN` | Bearer token or shared token for outbound webhook auth | Export when downstream webhook endpoints require token auth. | Webhook requests include expected auth header during smoke test. |

Migration and seed steps that must be present in README:
- `cd management-api && npx prisma migrate deploy`
- `cd management-api && npx prisma db seed`
- `cd scheduler && go build ./cmd/...`
- Optional schema sanity check for Go services: `cd scheduler && go test ./...`
- Create a sample tenant and job after services boot so the scheduler can discover runnable work immediately.

### 4. Getting Started checklist requirements
- The README must provide a sequential path: clone repository, prepare `.env`, export required variables, run migrations, seed data, start `docker compose up`, open `http://localhost:3000`, then confirm `http://localhost:4000/metrics`.
- The checklist must call out common failures: missing env vars, unapplied migrations, ports already in use, Redis/PostgreSQL connection failures, and unreachable workers.
- Log locations to inspect must be named directly in the README: `docker compose logs management-api`, `docker compose logs scheduler`, and worker container logs.

### 5. Validation and hand-off
- Validator: assigned doc reviewer.
- Done means:
  - Every Sprint 1 checklist item is verified or marked with a concrete blocker.
  - README setup sections reference the full env var and migration inventory.
  - Rendered Markdown contains no mojibake in architecture, setup, tables, or troubleshooting notes.
- README references after reorganization:
  - Prerequisites and env inventory: `README.md:78`
  - Migration, seeding, and verification flow: `README.md:96`
  - Troubleshooting checklist: `README.md:145`
- Hand-off note: reviewer should validate line references again after any later README edits that move sections.

## Sprint 2 - API reference & RBAC edge cases
### Status
- Completed in README.
- Coverage now includes endpoint-by-endpoint request and response shapes, status codes, pagination, tenant isolation, RBAC expectations, validation rules, idempotency guidance, SDK or CLI expectations, and manual verification steps.
- README references for Sprint 2:
  - Jobs API details: `README.md:184`
  - Tenant API details: `README.md:360`
  - RBAC, validation, and SDK or CLI expectations: `README.md:437`
  - Sprint 2 verification steps: `README.md:514`

### Delivered scope
1. **API request/response spec:** For each endpoint in README (jobs CRUD, job history, tenants), document:
   - HTTP method and path
   - Required headers (Authorization, X-Tenant-ID)
   - Request body schema (cron expression, payload, retry config)
   - Response shape (status, body, error structure)
   - Expected status codes (201, 200, 400, 401, 404, 429)
2. **Pagination & errors:** Define pagination parameters (`page`, `limit`) for list endpoints, describe rate limiting behavior, and capture sample error JSON for validation, including tenant/RBAC violations and validation failures (bad cron, missing payload).
3. **Tenant isolation + RBAC:** Document how tenant IDs are scoped to tokens, what happens if cross-tenant IDs are supplied, how roles (admin, viewer, scheduler) are enforced, and the exact error responses for violations (403 + `tenant_mismatch`).
4. **Validation & idempotency:** Note that job definitions go through cron parsing (reject invalid expressions), enforce `maxRetries`, and require idempotency keys when re-scheduling; mention the SDK/CLI should reject invalid payloads/client-side and describe the manual test steps (`curl POST /jobs` with sample body, check response for job ID, retry). In this section, add a subsection summarizing `@vinubabu/hestia-sdk` expectations (client should validate cron, JSON schema, check RBAC claims) and CLI tests (e.g., `hestia job create ...`).

## Sprint 3 - Scheduler + worker reliability story
### Status
- Completed in README.
- Coverage now includes leader election lock behavior, renewal cadence, failover handling, cron tick and dispatch sequence, retry FSM details, operational thresholds, and verification steps.
- README references for Sprint 3:
  - Leader election and dispatch narrative: `README.md:538`
  - Retry and backoff details: `README.md:572`
  - Metrics, thresholds, and verification checklist: `README.md:596`

### Delivered scope
1. **Leader election detail:** Document Redis usage (`SET key NX PX 10000`), TTL renewal cadence (renew at 60% of TTL), failure detection (if renew fails, release lock and promote failover), and metrics to confirm single leader (`scheduler_leader_elections_total` with labels). Include failure handling steps (acquire new lock, log info, notify metric).
2. **Cron tick + dispatch flow:** Sequence each step - leader fires tick, queries Postgres for due jobs, acquires distributed lock per job (`LOCK:<job_id>`), calls gRPC worker, handles worker response, updates Postgres event log. Define retry FSM transitions, explain exponential backoff with jitter calculation, and note what happens on Postgres deadlock or worker crash (log error, release lock, mark job `FAILED`).
3. **Instrumentation/optimizations:** Capture metric thresholds (e.g., alert if `scheduler_retry_attempts_total` increases 3x baseline, or if job duration > configured SLA). Mention Postgres indexes (jobs `(tenant_id, next_run_at)`, event log `(job_id, attempt)`) and Redis connection pooling as optimization notes.
4. **Verification steps:** Provide explicit tests (stop leader, ensure failover occurs within TTL; run job that crashes to confirm no duplicates; inspect event log entries for attempts). Record mission-critical metrics/traces to monitor (leader elections count, job dispatch latency, retry count) for SLO reporting.

## Sprint 4 - Observability & roadmap execution
### Status
- In progress.
- A minimal dashboard implementation is now planned as a near-term operational surface, using server-rendered static assets from the Management API to avoid adding a frontend toolchain before the data model settles.
- Immediate implementation references:
  - Management API dashboard summary endpoint: `management-api/server.js`
  - Static dashboard assets: `management-api/public/`

1. **Observability section details:** List Grafana panel specs (leader status, job throughput, retry ratio), Prometheus alerts (`scheduler_leader_elections_total` > 1/min, retry spike, job dispatch failure), and span expectations (trigger span per job from scheduler to worker). Assign alert owners (scheduler team, docs team) and maintenance cadence (weekly review of dashboards).
2. **Roadmap tasks turned into deliverables:** For each roadmap bullet, break into tasks with acceptance criteria:
   - Web UI dashboard: deliver a minimal operational dashboard first, then expand only after the scheduler and storage model stabilize.
   - Job dependency chains: define schema for dependencies, implement scheduler logic to enforce ordering, add tests for `run-after` semantics.
   - Tenant rate limiting: define rate tokens per tenant, implement guard rails in Management API and scheduler, include observability metrics for rate limit breaches.
   - Webhook notifications: design notification payload, implement worker webhook delivery with retries, document webhook signing and validation steps.
   - CLI for local testing: define commands, ensure they run jobs locally against the scheduler, and document steps in README.
3. **Operations/runbook:** Describe deployment steps on Railway (env vars, secrets, how to scale scheduler instances), rollback plan, and how to update README/plan when features ship (update plan file, note latch with release tag). Include monitoring steps verifying branch status after deployment.
4. **Next steps & maintenance:** Detail how to keep the plan current (assign owner, link to sprint board, mention when to revisit the plan), describe how to track sprint completion (tick checklist, note issues), and instructions for updating this plan document whenever requirements change.

### Dashboard delivery track
1. **Phase 1 - Minimal operational UI**
   - Serve static dashboard files directly from the Management API at `/`.
   - Add a dashboard summary endpoint that returns tenant counts, job status counts, scheduler metrics, and recent jobs from the current JSON-backed store.
   - Add a tenant listing endpoint so the UI can switch context without shell commands.
   - Provide forms for creating tenants and jobs with the existing bearer-token model and idempotency-key requirements.
   - Acceptance criteria:
     - A user can open the dashboard in a browser with no extra install step.
     - A user can create a tenant, create a job, switch tenant scope, and inspect recent job history.
     - A user can see scheduler leader state, election count, retries, and dispatch totals.
2. **Phase 2 - Better operator workflow**
   - Add job detail refresh, delete or pause actions, and inline history filtering.
   - Add scheduler health probes for multiple instances once the scheduler exposes a stable multi-instance status surface.
   - Add validation hints for cron syntax and payload JSON.
   - Acceptance criteria:
     - Most manual API smoke tests can be driven from the dashboard.
     - The UI remains dependency-light and works with the local dev stack.
3. **Phase 3 - Production-grade frontend decision**
   - Reassess whether a dedicated React app is worth the extra build tooling after storage and auth are no longer prototype-only.
   - If adopted, keep the same API contracts and migrate incrementally instead of replacing the dashboard all at once.
   - Acceptance criteria:
     - Frontend framework choice is driven by product complexity, not by setup preference alone.

## Test Plan
- Follow the "Getting Started verification" checklist from Sprint 1 to ensure README/setup instructions are accurate.
- Use the expanded API reference to manually create a job and tenant via HTTP calls; verify RBAC/tenant isolation errors match the documented responses.
- Execute scheduler failover simulations and invalid job handling to confirm the instrumentation/metrics in Sprint 3 behave as described.
- Validate each Sprint 4 roadmap task through quick smoke tests (UI panel renders, dependency chain executes, rate limit triggers, webhook notifications deliver, CLI commands run). Document results in this plan file.
- For the dashboard track, verify `/` loads, `/dashboard` returns a summary for the current token scope, tenant and job creation forms succeed, and recent history updates after the scheduler executes a job.

## Assumptions & Notes
- Plan creation and updates occur in this file; implementation of the described steps happens in future sprints.
- Infrastructure assumptions remain PostgreSQL + Redis + Docker Compose unless overridden by later plan updates.
- Sprint durations and available contributors are assumed to be stable; adjust the plan outside this document if that changes.

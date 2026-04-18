CREATE TABLE IF NOT EXISTS _migrations (
  name       TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenants (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  slug                  TEXT NOT NULL UNIQUE,
  rate_limit_per_minute INT  NOT NULL DEFAULT 120,
  webhook_url           TEXT,
  webhook_secret_ref    TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS jobs (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(slug),
  name                  TEXT NOT NULL,
  execution_mode        TEXT NOT NULL DEFAULT 'cron',
  schedule              TEXT,
  run_at                TIMESTAMPTZ,
  payload               JSONB NOT NULL DEFAULT '{}',
  max_retries           INT  NOT NULL DEFAULT 3,
  retry_backoff_seconds INT  NOT NULL DEFAULT 60,
  state                 TEXT NOT NULL DEFAULT 'ACTIVE',
  next_run_at           TIMESTAMPTZ,
  retry_count           INT  NOT NULL DEFAULT 0,
  last_error            TEXT,
  locked_until          TIMESTAMPTZ,
  deleted_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant_next_run ON jobs (tenant_id, next_run_at);

CREATE TABLE IF NOT EXISTS event_log (
  id              BIGSERIAL PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id),
  tenant_id       TEXT NOT NULL,
  attempt         INT  NOT NULL,
  status          TEXT NOT NULL,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  duration_ms     INT,
  failure_reason  TEXT,
  idempotency_key TEXT,
  worker          TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_log_job ON event_log (job_id, attempt);

CREATE TABLE IF NOT EXISTS idempotency_log (
  key              TEXT NOT NULL,
  route_key        TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  response_payload JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (key, route_key)
);

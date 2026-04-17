package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Job struct {
	ID                  string
	TenantID            string
	ExecutionMode       string
	Schedule            *string
	PayloadJSON         string
	MaxRetries          int
	RetryBackoffSeconds int
	State               string
	RetryCount          int
}

type EventLogEntry struct {
	JobID          string
	TenantID       string
	Attempt        int
	Status         string
	StartedAt      time.Time
	FinishedAt     time.Time
	DurationMs     int
	FailureReason  string
	IdempotencyKey string
	Worker         string
}

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

func (s *Store) DueJobs(ctx context.Context) ([]Job, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, tenant_id, execution_mode, schedule, payload::text,
		       max_retries, retry_backoff_seconds, state, retry_count
		FROM jobs
		WHERE next_run_at <= NOW()
		  AND state IN ('ACTIVE', 'RETRYING')
		  AND (locked_until IS NULL OR locked_until < NOW())
		  AND deleted_at IS NULL
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var jobs []Job
	for rows.Next() {
		var j Job
		if err := rows.Scan(&j.ID, &j.TenantID, &j.ExecutionMode, &j.Schedule,
			&j.PayloadJSON, &j.MaxRetries, &j.RetryBackoffSeconds, &j.State, &j.RetryCount); err != nil {
			return nil, err
		}
		jobs = append(jobs, j)
	}
	return jobs, rows.Err()
}

func (s *Store) MarkSuccess(ctx context.Context, jobID string, nextRunAt time.Time) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE jobs SET state = 'ACTIVE', retry_count = 0, next_run_at = $1,
		               last_error = NULL, updated_at = NOW()
		WHERE id = $2
	`, nextRunAt, jobID)
	return err
}

func (s *Store) MarkFailed(ctx context.Context, jobID, reason string, maxRetries, retryCount, backoffSeconds int) error {
	if retryCount < maxRetries {
		delaySec := backoffSeconds * (1 << retryCount)
		nextRunAt := time.Now().Add(time.Duration(delaySec) * time.Second)
		_, err := s.pool.Exec(ctx, `
			UPDATE jobs SET state = 'RETRYING', retry_count = retry_count + 1,
			               next_run_at = $1, last_error = $2, updated_at = NOW()
			WHERE id = $3
		`, nextRunAt, reason, jobID)
		return err
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE jobs SET state = 'FAILED', last_error = $1, updated_at = NOW()
		WHERE id = $2
	`, reason, jobID)
	return err
}

func (s *Store) WriteEventLog(ctx context.Context, e EventLogEntry) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO event_log
		  (job_id, tenant_id, attempt, status, started_at, finished_at,
		   duration_ms, failure_reason, idempotency_key, worker)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
	`, e.JobID, e.TenantID, e.Attempt, e.Status,
		e.StartedAt, e.FinishedAt, e.DurationMs,
		nullableString(e.FailureReason), e.IdempotencyKey, e.Worker)
	return err
}

func nullableString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

package dispatch

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/robfig/cron/v3"

	"github.com/vinubabu/hestia/scheduler/internal/store"
)

type Dispatcher struct {
	store           *store.Store
	rdb             *redis.Client
	worker          *WorkerClient
	dispatchTimeout time.Duration
}

func New(s *store.Store, rdb *redis.Client, worker *WorkerClient, dispatchTimeout time.Duration) *Dispatcher {
	return &Dispatcher{store: s, rdb: rdb, worker: worker, dispatchTimeout: dispatchTimeout}
}

// Tick queries due jobs and dispatches each in its own goroutine.
func (d *Dispatcher) Tick(ctx context.Context) {
	jobs, err := d.store.DueJobs(ctx)
	if err != nil {
		fmt.Printf("tick: query error: %v\n", err)
		return
	}
	for _, job := range jobs {
		go d.dispatch(ctx, job)
	}
}

func (d *Dispatcher) dispatch(ctx context.Context, job store.Job) {
	lockKey := "lock:job:" + job.ID
	idemKey := fmt.Sprintf("idem:%s:%s", job.ID, job.NextRunAt.UTC().Format(time.RFC3339Nano))

	// 1. Acquire per-job Redis lock
	acquired, err := d.rdb.SetArgs(ctx, lockKey, "1", redis.SetArgs{
		Mode: "NX",
		TTL:  d.dispatchTimeout + 2*time.Second,
	}).Result()
	if err != nil || acquired != "OK" {
		return // already locked by another scheduler instance
	}
	defer d.rdb.Del(ctx, lockKey)

	// 2. Idempotency check — skip if already dispatched this attempt
	exists, _ := d.rdb.Exists(ctx, idemKey).Result()
	if exists > 0 {
		return
	}

	// 3. Health-check the worker before dispatching
	if err := d.worker.Ping(ctx); err != nil {
		fmt.Printf("dispatch: worker unreachable, skipping job %s: %v\n", job.ID, err)
		return
	}

	// 4. Mark dispatched in Redis before calling Execute
	d.rdb.Set(ctx, idemKey, "1", 24*time.Hour)

	startedAt := time.Now()
	resp, execErr := d.worker.Execute(ctx, &ExecuteRequest{
		JobID:          job.ID,
		TenantID:       job.TenantID,
		IdempotencyKey: idemKey,
		PayloadJSON:    job.PayloadJSON,
		Attempt:        int32(job.RetryCount + 1),
	}, d.dispatchTimeout)
	finishedAt := time.Now()
	durationMs := int(finishedAt.Sub(startedAt).Milliseconds())

	// 5. Determine outcome
	success := execErr == nil && resp != nil && resp.Success
	failReason := ""
	if execErr != nil {
		failReason = execErr.Error()
	} else if resp != nil && !resp.Success {
		failReason = resp.ErrorMessage
	}

	status := "SUCCESS"
	if !success {
		status = "FAILED"
	}

	// 6. Write event log
	d.store.WriteEventLog(ctx, store.EventLogEntry{
		JobID:          job.ID,
		TenantID:       job.TenantID,
		Attempt:        job.RetryCount + 1,
		Status:         status,
		StartedAt:      startedAt,
		FinishedAt:     finishedAt,
		DurationMs:     durationMs,
		FailureReason:  failReason,
		IdempotencyKey: idemKey,
		Worker:         "go-worker",
	})

	// 7. Advance job state
	if success {
		nextRunAt := computeNextRunAt(job)
		d.store.MarkSuccess(ctx, job, nextRunAt)
	} else {
		d.store.MarkFailed(ctx, job.ID, failReason, job.MaxRetries, job.RetryCount, job.RetryBackoffSeconds)
	}
}

var cronParser = cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)

func computeNextRunAt(job store.Job) *time.Time {
	if job.ExecutionMode == "cron" && job.Schedule != nil {
		if nextRunAt, ok := parseEverySchedule(*job.Schedule, time.Now()); ok {
			return &nextRunAt
		}
		if sched, err := cronParser.Parse(*job.Schedule); err == nil {
			nextRunAt := sched.Next(time.Now())
			return &nextRunAt
		}
	}
	return nil
}

func parseEverySchedule(schedule string, from time.Time) (time.Time, bool) {
	if !strings.HasPrefix(schedule, "@every ") {
		return time.Time{}, false
	}

	duration, err := time.ParseDuration(strings.TrimSpace(strings.TrimPrefix(schedule, "@every ")))
	if err != nil {
		return time.Time{}, false
	}

	return from.Add(duration), true
}

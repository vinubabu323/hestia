package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/vinubabu/hestia/scheduler/internal/config"
	"github.com/vinubabu/hestia/scheduler/internal/dispatch"
	"github.com/vinubabu/hestia/scheduler/internal/leader"
	"github.com/vinubabu/hestia/scheduler/internal/store"
	"github.com/vinubabu/hestia/scheduler/internal/tick"
)

func main() {
	cfg := config.Load()

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "postgres connect: %v\n", err)
		os.Exit(1)
	}
	defer pool.Close()

	opt, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "redis parse: %v\n", err)
		os.Exit(1)
	}
	rdb := redis.NewClient(opt)
	defer rdb.Close()

	workerClient, err := dispatch.NewWorkerClient(cfg.GRPCWorkerAddr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "grpc connect: %v\n", err)
		os.Exit(1)
	}
	defer workerClient.Close()

	instanceID := fmt.Sprintf("%s-%d", hostname(), os.Getpid())
	s := store.New(pool)

	election := leader.New(
		rdb, instanceID,
		time.Duration(cfg.LeaderTTLMs)*time.Millisecond,
		time.Duration(cfg.LeaderRenewMs)*time.Millisecond,
	)
	dispatcher := dispatch.New(s, rdb, workerClient,
		time.Duration(cfg.DispatchTimeoutMs)*time.Millisecond)
	ticker := tick.New(dispatcher, election,
		time.Duration(cfg.TickMs)*time.Millisecond)

	go election.Run(ctx)
	go ticker.Run(ctx)

	fmt.Printf("scheduler started instance=%s\n", instanceID)
	<-ctx.Done()
	fmt.Println("scheduler shutting down")
}

func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return h
}

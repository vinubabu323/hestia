package config

import (
	"os"
	"strconv"
)

type Config struct {
	DatabaseURL       string
	RedisURL          string
	WorkerURL         string
	SchedulerPort     int
	TickMs            int
	LeaderTTLMs       int
	LeaderRenewMs     int
	DispatchTimeoutMs int
}

func Load() Config {
	return Config{
		DatabaseURL:       mustEnv("DATABASE_URL"),
		RedisURL:          mustEnv("REDIS_URL"),
		WorkerURL:         mustEnv("WORKER_URL"),
		SchedulerPort:     envInt("GRPC_PORT", 4000),
		TickMs:            envInt("SCHEDULER_TICK_MS", 2000),
		LeaderTTLMs:       envInt("LEADER_TTL_MS", 10000),
		LeaderRenewMs:     envInt("LEADER_RENEW_MS", 6000),
		DispatchTimeoutMs: envInt("DISPATCH_TIMEOUT_MS", 8000),
	}
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		panic("missing required env var: " + key)
	}
	return v
}

func envInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

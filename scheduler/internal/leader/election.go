package leader

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const leaderKey = "scheduler:leader"

type Election struct {
	rdb        *redis.Client
	instanceID string
	ttl        time.Duration
	renewEvery time.Duration
	isLeader   bool
}

func New(rdb *redis.Client, instanceID string, ttl, renewEvery time.Duration) *Election {
	return &Election{
		rdb:        rdb,
		instanceID: instanceID,
		ttl:        ttl,
		renewEvery: renewEvery,
	}
}

func (e *Election) IsLeader() bool {
	return e.isLeader
}

// Run blocks until ctx is cancelled. Call in a goroutine.
func (e *Election) Run(ctx context.Context) {
	ticker := time.NewTicker(e.renewEvery)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			e.tick(ctx)
		}
	}
}

func (e *Election) tick(ctx context.Context) {
	if e.isLeader {
		// Renew: only update if we still own the key
		ok, err := e.rdb.SetArgs(ctx, leaderKey, e.instanceID, redis.SetArgs{
			Mode: "XX",
			TTL:  e.ttl,
		}).Result()
		if err != nil || ok != "OK" {
			e.isLeader = false
			fmt.Printf("leader: %s lost leadership\n", e.instanceID)
		}
		return
	}

	// Acquire: only set if key does not exist
	ok, err := e.rdb.SetArgs(ctx, leaderKey, e.instanceID, redis.SetArgs{
		Mode: "NX",
		TTL:  e.ttl,
	}).Result()
	if err != nil {
		return
	}
	if ok == "OK" {
		e.isLeader = true
		fmt.Printf("leader: %s acquired leadership\n", e.instanceID)
	}
}

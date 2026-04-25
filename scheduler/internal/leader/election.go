package leader

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const leaderKey = "scheduler:leader"
const leaderElectionsKey = "scheduler:metrics:leader_elections_total"
const instanceKeyPrefix = "scheduler:instance:"

type Election struct {
	rdb        *redis.Client
	instanceID string
	port       int
	ttl        time.Duration
	renewEvery time.Duration
	isLeader   bool
}

type heartbeatPayload struct {
	InstanceID    string `json:"instanceId"`
	SchedulerPort int    `json:"schedulerPort"`
	LastSeenAt    string `json:"lastSeenAt"`
}

func New(rdb *redis.Client, instanceID string, port int, ttl, renewEvery time.Duration) *Election {
	return &Election{
		rdb:        rdb,
		instanceID: instanceID,
		port:       port,
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
	e.publishHeartbeat(ctx)

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
		e.rdb.Incr(ctx, leaderElectionsKey)
		fmt.Printf("leader: %s acquired leadership\n", e.instanceID)
	}
}

func (e *Election) publishHeartbeat(ctx context.Context) {
	payload, err := json.Marshal(heartbeatPayload{
		InstanceID:    e.instanceID,
		SchedulerPort: e.port,
		LastSeenAt:    time.Now().UTC().Format(time.RFC3339Nano),
	})
	if err != nil {
		return
	}

	e.rdb.Set(ctx, instanceKeyPrefix+e.instanceID, payload, e.ttl)
}

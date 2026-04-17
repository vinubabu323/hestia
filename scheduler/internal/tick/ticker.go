package tick

import (
	"context"
	"time"

	"github.com/vinubabu/hestia/scheduler/internal/dispatch"
	"github.com/vinubabu/hestia/scheduler/internal/leader"
)

type Ticker struct {
	dispatcher *dispatch.Dispatcher
	election   *leader.Election
	interval   time.Duration
}

func New(d *dispatch.Dispatcher, e *leader.Election, interval time.Duration) *Ticker {
	return &Ticker{dispatcher: d, election: e, interval: interval}
}

// Run blocks until ctx is cancelled. Call in a goroutine.
func (t *Ticker) Run(ctx context.Context) {
	ticker := time.NewTicker(t.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if t.election.IsLeader() {
				t.dispatcher.Tick(ctx)
			}
		}
	}
}

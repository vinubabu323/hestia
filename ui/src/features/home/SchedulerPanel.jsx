export default function SchedulerPanel({ scheduler }) {
  if (!scheduler) return null

  const { metrics = {}, instances = [], instanceCount, leader, leaderExpiresAt } = scheduler

  return (
    <div className="stack">
      <div className="scheduler-grid">
        <div className="scheduler-item"><strong>Schedulers</strong><span>{instanceCount}</span></div>
        <div className="scheduler-item"><strong>Leader</strong><span>{leader || 'No leader yet'}</span></div>
        <div className="scheduler-item"><strong>Lease Expires</strong><span>{leaderExpiresAt || 'n/a'}</span></div>
        <div className="scheduler-item"><strong>Leader Elections</strong><span>{metrics.leaderElectionsTotal}</span></div>
        <div className="scheduler-item"><strong>Jobs Dispatched</strong><span>{metrics.jobsDispatchedTotal}</span></div>
        <div className="scheduler-item"><strong>Retry Attempts</strong><span>{metrics.retryAttemptsTotal}</span></div>
      </div>
      <div className="scheduler-list">
        {instances.length === 0
          ? <div className="empty">No scheduler heartbeats yet.</div>
          : instances.map((inst) => (
              <div key={inst.instanceId} className={`scheduler-item${inst.leader ? ' leader' : ''}`}>
                <strong>{inst.instanceId}</strong>
                <div>Port: {inst.schedulerPort}</div>
                <div>Status: {inst.leader ? 'Leader' : 'Follower'}</div>
                <div>Last Seen: {inst.lastSeenAt}</div>
              </div>
            ))
        }
      </div>
    </div>
  )
}

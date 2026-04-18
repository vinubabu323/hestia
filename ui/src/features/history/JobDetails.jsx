export default function JobDetails({ job }) {
  if (!job) {
    return <div className="details-grid empty">Pick a job to inspect its details.</div>
  }

  return (
    <div className="details-grid">
      <div className="detail-card">
        <strong>{job.name}</strong>
        <div>ID: {job.id}</div>
        <div>Tenant: {job.tenantId}</div>
        <div>Mode: {job.executionMode}</div>
        <div>Status: {job.status}</div>
      </div>
      <div className="detail-card">
        <strong>Schedule</strong>
        <div>{job.executionMode === 'queue' ? (job.runAt || 'immediate') : job.cron}</div>
        <div>Next Run: {job.nextRunAt || 'n/a'}</div>
        <div>Max Retries: {job.maxRetries}</div>
        <div>Backoff: {job.retryBackoffSeconds}s</div>
      </div>
      <div className="detail-card">
        <strong>Payload</strong>
        <pre>{JSON.stringify(job.payload, null, 2)}</pre>
      </div>
    </div>
  )
}

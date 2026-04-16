export default function JobsTable({ jobs, onViewHistory }) {
  if (!jobs || jobs.length === 0) {
    return <div className="empty">No jobs for this tenant yet.</div>
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Mode</th>
            <th>Status</th>
            <th>Schedule</th>
            <th>Next Run</th>
            <th>History</th>
            <th>Last Error</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>
                <span className="job-name">{job.name}</span>
                <span>{job.id}</span>
              </td>
              <td>{job.executionMode}</td>
              <td>
                <span className={`pill ${job.status.toLowerCase()}`}>{job.status}</span>
              </td>
              <td>{job.executionMode === 'queue' ? (job.runAt || 'immediate') : job.cron}</td>
              <td>{job.nextRunAt || 'n/a'}</td>
              <td>{job.historyCount}</td>
              <td>{job.lastError || ''}</td>
              <td>
                <button type="button" className="secondary" onClick={() => onViewHistory(job.id)}>
                  History
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

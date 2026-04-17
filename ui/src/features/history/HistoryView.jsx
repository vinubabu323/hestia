import { useState, useEffect } from 'react'
import JobDetails from './JobDetails.jsx'
import AttemptsList from './AttemptsList.jsx'
import { fetchJobHistory } from '../../api/client.js'

export default function HistoryView({
  dashboardState,
  token,
  selectedTenant,
  activeJobId,
  onJobSelect,
  onLog
}) {
  const [history, setHistory] = useState(null)
  const [historyError, setHistoryError] = useState(null)

  const jobs = dashboardState?.jobs || []
  const activeJob = jobs.find((j) => j.id === activeJobId) || null

  useEffect(() => {
    if (!activeJobId || !selectedTenant) {
      setHistory(null)
      setHistoryError(null)
      return
    }

    fetchJobHistory(token, selectedTenant, activeJobId)
      .then((data) => {
        setHistory(data.items)
        setHistoryError(null)
      })
      .catch((err) => {
        setHistory(null)
        setHistoryError(err.message)
      })
  }, [activeJobId, selectedTenant, token])

  const emptyMessage = historyError
    || (!activeJobId ? 'Pick a job to load history.' : null)

  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <h2>Job History</h2>
          <select
            value={activeJobId || ''}
            onChange={(e) => onJobSelect(e.target.value || null)}
          >
            {jobs.length === 0
              ? <option value="">No jobs</option>
              : jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.name} - {j.status}
                  </option>
                ))
            }
          </select>
        </div>
        <JobDetails job={activeJob} />
      </section>

      <section className="panel">
        <div className="panel-heading"><h2>Attempts</h2></div>
        <AttemptsList items={history} emptyMessage={emptyMessage} />
      </section>
    </>
  )
}

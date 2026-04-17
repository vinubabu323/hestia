import StatsGrid from './StatsGrid.jsx'
import SchedulerPanel from './SchedulerPanel.jsx'
import CreateTenantForm from './CreateTenantForm.jsx'
import CreateJobForm from './CreateJobForm.jsx'
import JobsTable from './JobsTable.jsx'

export default function HomeView({
  dashboardState,
  token,
  selectedTenant,
  idempotencyKey,
  onIdempotencyChange,
  onLog,
  onRefresh,
  onTenantCreated,
  onGoToHistory
}) {
  return (
    <>
      <StatsGrid overview={dashboardState?.overview} />

      <section className="main-grid">
        <div className="panel">
          <div className="panel-heading"><h2>Schedulers</h2></div>
          <SchedulerPanel scheduler={dashboardState?.scheduler} />
        </div>
        <div className="panel">
          <div className="panel-heading"><h2>Create Tenant</h2></div>
          <CreateTenantForm
            token={token}
            onLog={onLog}
            onRefresh={onRefresh}
            onTenantCreated={onTenantCreated}
          />
        </div>
      </section>

      <section className="main-grid">
        <div className="panel">
          <div className="panel-heading"><h2>Create Job</h2></div>
          <CreateJobForm
            token={token}
            selectedTenant={selectedTenant}
            idempotencyKey={idempotencyKey}
            onIdempotencyChange={onIdempotencyChange}
            onLog={onLog}
            onRefresh={onRefresh}
            onJobCreated={(jobId) => onGoToHistory(jobId)}
          />
        </div>
        <div className="panel">
          <div className="panel-heading">
            <h2>Jobs</h2>
            <button type="button" className="secondary" onClick={() => onGoToHistory(null)}>
              View All Job History
            </button>
          </div>
          <JobsTable jobs={dashboardState?.jobs} onViewHistory={onGoToHistory} />
        </div>
      </section>
    </>
  )
}

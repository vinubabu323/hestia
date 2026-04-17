export default function StatsGrid({ overview }) {
  if (!overview) return null

  const cards = [
    ['Tenants', overview.tenantCount],
    ['Jobs', overview.jobCount],
    ['Active', overview.activeJobs],
    ['Retrying', overview.retryingJobs],
    ['Failed', overview.failedJobs],
    ['Running', overview.runningJobs]
  ]

  return (
    <section className="stats">
      {cards.map(([label, value]) => (
        <div key={label} className="stat">
          <div className="stat-label">{label}</div>
          <div className="stat-value">{value}</div>
        </div>
      ))}
    </section>
  )
}

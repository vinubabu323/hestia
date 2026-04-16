import { useState, useCallback, useEffect } from 'react'
import Topbar from './shared/Topbar.jsx'
import Controls from './shared/Controls.jsx'
import ResponseLog from './shared/ResponseLog.jsx'
import HomeView from './features/home/HomeView.jsx'
import HistoryView from './features/history/HistoryView.jsx'
import { fetchDashboard } from './api/client.js'

function nowToken() {
  return `ui-${Date.now()}`
}

export default function App() {
  const [token, setToken] = useState('admin-token')
  const [selectedTenant, setSelectedTenant] = useState('')
  const [idempotencyKey, setIdempotencyKey] = useState(nowToken)
  const [currentView, setCurrentView] = useState('home')
  const [dashboardState, setDashboardState] = useState(null)
  const [log, setLog] = useState({ text: 'Ready.', payload: null })
  const [activeJobId, setActiveJobId] = useState(null)

  const logMessage = useCallback((text, payload = null) => {
    setLog({ text, payload })
  }, [])

  const refreshDashboard = useCallback(async ({ tokenOverride, tenantOverride } = {}) => {
    const t = tokenOverride ?? token
    const tenant = tenantOverride ?? selectedTenant
    try {
      const summary = await fetchDashboard(t, tenant || null)
      setDashboardState(summary)
      setSelectedTenant((prev) => prev || summary.selectedTenant || '')
      logMessage('Dashboard refreshed.', summary.overview)
    } catch (err) {
      logMessage(`Refresh failed: ${err.message}`)
    }
  }, [token, selectedTenant, logMessage])

  useEffect(() => {
    refreshDashboard()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function handleTokenChange(newToken) {
    setToken(newToken)
  }

  function handleTokenBlur(newToken) {
    setToken(newToken)
    refreshDashboard({ tokenOverride: newToken })
  }

  function handleTenantChange(slug) {
    setSelectedTenant(slug)
    refreshDashboard({ tenantOverride: slug })
  }

  function handleGoToHistory(jobId) {
    setActiveJobId(jobId)
    setCurrentView('history')
  }

  const tenants = dashboardState?.tenants || []

  return (
    <div className="page">
      <Topbar
        currentView={currentView}
        onViewChange={setCurrentView}
        onRefresh={() => refreshDashboard()}
      />
      <Controls
        token={token}
        onTokenChange={handleTokenChange}
        onTokenBlur={handleTokenBlur}
        selectedTenant={selectedTenant}
        onTenantChange={handleTenantChange}
        tenants={tenants}
        idempotencyKey={idempotencyKey}
        onIdempotencyChange={setIdempotencyKey}
      />

      {currentView === 'home' && (
        <HomeView
          dashboardState={dashboardState}
          token={token}
          selectedTenant={selectedTenant}
          idempotencyKey={idempotencyKey}
          onIdempotencyChange={setIdempotencyKey}
          onLog={logMessage}
          onRefresh={refreshDashboard}
          onTenantCreated={(slug) => setSelectedTenant(slug)}
          onGoToHistory={handleGoToHistory}
        />
      )}

      {currentView === 'history' && (
        <HistoryView
          dashboardState={dashboardState}
          token={token}
          selectedTenant={selectedTenant}
          activeJobId={activeJobId}
          onJobSelect={setActiveJobId}
          onLog={logMessage}
        />
      )}

      <ResponseLog text={log.text} payload={log.payload} />
    </div>
  )
}

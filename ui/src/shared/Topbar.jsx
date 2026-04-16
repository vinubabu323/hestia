export default function Topbar({ currentView, onViewChange, onRefresh }) {
  return (
    <header className="topbar">
      <div>
        <h1>Hestia</h1>
        <p>Jobs, tenants, and scheduler state in one place.</p>
      </div>
      <div className="topbar-actions">
        <nav className="view-nav">
          <button
            type="button"
            className={`secondary${currentView === 'home' ? ' active' : ''}`}
            onClick={() => onViewChange('home')}
          >
            Home
          </button>
          <button
            type="button"
            className={`secondary${currentView === 'history' ? ' active' : ''}`}
            onClick={() => onViewChange('history')}
          >
            Job History
          </button>
        </nav>
        <button type="button" onClick={onRefresh}>Refresh</button>
      </div>
    </header>
  )
}

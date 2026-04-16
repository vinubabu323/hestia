export default function AttemptsList({ items, emptyMessage }) {
  if (emptyMessage) {
    return <div className="history-list empty">{emptyMessage}</div>
  }
  if (!items || items.length === 0) {
    return <div className="history-list empty">No attempts yet.</div>
  }

  return (
    <div className="history-list">
      {[...items].reverse().map((item, i) => (
        <div key={i} className="history-item">
          <strong>Attempt {item.attempt} - {item.status}</strong>
          <div>Started: {item.startedAt}</div>
          <div>Finished: {item.finishedAt}</div>
          <div>Duration: {item.durationMs} ms</div>
          <div>Worker: {item.worker}</div>
          {item.failureReason && <div>Failure: {item.failureReason}</div>}
        </div>
      ))}
    </div>
  )
}

export default function ResponseLog({ text, payload }) {
  const content = payload
    ? `${text}\n${JSON.stringify(payload, null, 2)}`
    : text

  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Response Log</h2>
      </div>
      <pre className="log-panel">{content}</pre>
    </section>
  )
}

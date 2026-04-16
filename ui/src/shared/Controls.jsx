export default function Controls({
  token,
  onTokenChange,
  onTokenBlur,
  selectedTenant,
  onTenantChange,
  tenants,
  idempotencyKey,
  onIdempotencyChange
}) {
  return (
    <section className="controls">
      <label>
        <span>Bearer token</span>
        <input
          type="text"
          value={token}
          autoComplete="off"
          onChange={(e) => onTokenChange(e.target.value)}
          onBlur={(e) => onTokenBlur(e.target.value)}
        />
      </label>
      <label>
        <span>Tenant</span>
        <select value={selectedTenant} onChange={(e) => onTenantChange(e.target.value)}>
          <option value="">-- select tenant --</option>
          {tenants.map((t) => (
            <option key={t.slug} value={t.slug}>
              {t.slug} ({t.jobCount} jobs)
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Idempotency key</span>
        <input
          type="text"
          value={idempotencyKey}
          autoComplete="off"
          onChange={(e) => onIdempotencyChange(e.target.value)}
        />
      </label>
    </section>
  )
}

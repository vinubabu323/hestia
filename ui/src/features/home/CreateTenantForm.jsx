import { createTenant } from '../../api/client.js'

export default function CreateTenantForm({ token, onLog, onRefresh, onTenantCreated }) {
  async function handleSubmit(e) {
    e.preventDefault()
    const data = new FormData(e.target)
    const payload = {
      name: String(data.get('name') || '').trim(),
      slug: String(data.get('slug') || '').trim(),
      rateLimitPerMinute: Number(data.get('rateLimitPerMinute') || 120)
    }
    try {
      const created = await createTenant(token, payload)
      e.target.reset()
      e.target.elements.rateLimitPerMinute.value = '120'
      onLog('Tenant created.', created)
      await onRefresh()
      onTenantCreated(created.slug)
    } catch (err) {
      onLog(`Create tenant failed: ${err.message}`, payload)
    }
  }

  return (
    <form className="stack" onSubmit={handleSubmit}>
      <input name="name" type="text" placeholder="Acme Corp" required />
      <input name="slug" type="text" placeholder="acme-corp" required />
      <input name="rateLimitPerMinute" type="number" min="1" defaultValue="120" required />
      <button type="submit">Create Tenant</button>
    </form>
  )
}

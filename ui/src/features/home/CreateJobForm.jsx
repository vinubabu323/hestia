import { useState } from 'react'
import { createJob } from '../../api/client.js'

function nowToken() {
  return `ui-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

export default function CreateJobForm({
  token,
  selectedTenant,
  idempotencyKey,
  onIdempotencyChange,
  onLog,
  onRefresh,
  onJobCreated
}) {
  const [executionMode, setExecutionMode] = useState('cron')

  async function handleSubmit(e) {
    e.preventDefault()
    if (!selectedTenant) {
      onLog('Pick a tenant before creating a job.')
      return
    }

    const data = new FormData(e.target)
    let parsedPayload
    try {
      parsedPayload = JSON.parse(String(data.get('payload') || '{}'))
    } catch (err) {
      onLog(`Payload JSON is invalid: ${err.message}`)
      return
    }

    const key = idempotencyKey.trim() || nowToken()
    onIdempotencyChange(key)

    const payload = {
      name: String(data.get('name') || '').trim(),
      executionMode: String(data.get('executionMode') || 'cron'),
      payload: parsedPayload,
      maxRetries: Number(data.get('maxRetries') || 3),
      retryBackoffSeconds: Number(data.get('retryBackoffSeconds') || 1)
    }

    if (payload.executionMode === 'cron') {
      payload.cron = String(data.get('cron') || '').trim()
    } else if (data.get('runAt')) {
      payload.runAt = new Date(String(data.get('runAt'))).toISOString()
    }

    try {
      const created = await createJob(token, selectedTenant, key, payload)
      onIdempotencyChange(nowToken())
      onLog('Job created.', created)
      await onRefresh()
      onJobCreated(created.id)
    } catch (err) {
      onIdempotencyChange(nowToken())
      onLog(`Create job failed: ${err.message}`, payload)
    }
  }

  return (
    <form className="stack" onSubmit={handleSubmit}>
      <input name="name" type="text" placeholder="heartbeat" required />
      <select
        name="executionMode"
        value={executionMode}
        onChange={(e) => setExecutionMode(e.target.value)}
      >
        <option value="cron">Recurring Cron Job</option>
        <option value="queue">One-Time Queue Job</option>
      </select>
      <input
        name="cron"
        type="text"
        placeholder={executionMode === 'queue' ? 'Queue jobs do not use cron' : '@every 10s'}
        defaultValue="@every 10s"
        disabled={executionMode === 'queue'}
        required={executionMode === 'cron'}
      />
      <input
        name="runAt"
        type="datetime-local"
        disabled={executionMode === 'cron'}
      />
      <input name="maxRetries" type="number" min="1" max="10" defaultValue="3" required />
      <input name="retryBackoffSeconds" type="number" min="1" defaultValue="1" required />
      <textarea name="payload" rows="7" required defaultValue='{"message":"hello from dashboard"}' />
      <button type="submit">Create Job</button>
    </form>
  )
}

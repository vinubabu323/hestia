const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000'

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, options)
  const text = await response.text()
  const data = text ? JSON.parse(text) : {}
  if (!response.ok) {
    throw new Error(data.error?.message || `${response.status} ${response.statusText}`)
  }
  return data
}

export async function fetchDashboard(token, tenantId) {
  const headers = { Authorization: `Bearer ${token}` }
  if (tenantId) headers['X-Tenant-ID'] = tenantId
  return request('/dashboard', { headers })
}

export async function createTenant(token, payload) {
  return request('/tenants', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })
}

export async function createJob(token, tenantId, idempotencyKey, payload) {
  return request('/jobs', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Tenant-ID': tenantId,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify(payload)
  })
}

export async function fetchJobHistory(token, tenantId, jobId) {
  return request(`/jobs/${jobId}/history?page=1&limit=50`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Tenant-ID': tenantId
    }
  })
}

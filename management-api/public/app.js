const tokenInput = document.querySelector("#tokenInput");
const tenantSelect = document.querySelector("#tenantSelect");
const idempotencyInput = document.querySelector("#idempotencyInput");
const refreshButton = document.querySelector("#refreshButton");
const homeTab = document.querySelector("#homeTab");
const historyTab = document.querySelector("#historyTab");
const homeView = document.querySelector("#homeView");
const historyView = document.querySelector("#historyView");
const statsGrid = document.querySelector("#statsGrid");
const schedulerPanel = document.querySelector("#schedulerPanel");
const tenantForm = document.querySelector("#tenantForm");
const jobForm = document.querySelector("#jobForm");
const executionModeSelect = document.querySelector("#executionModeSelect");
const runAtInput = document.querySelector("#runAtInput");
const viewAllJobsButton = document.querySelector("#viewAllJobsButton");
const jobSelect = document.querySelector("#jobSelect");
const jobDetailsPanel = document.querySelector("#jobDetailsPanel");
const historyPanel = document.querySelector("#historyPanel");
const jobsTable = document.querySelector("#jobsTable");
const logPanel = document.querySelector("#logPanel");

let dashboardState = null;
let currentView = "home";

function nowToken() {
  return `ui-${Date.now()}`;
}

function log(message, payload) {
  const text = payload ? `${message}\n${JSON.stringify(payload, null, 2)}` : message;
  logPanel.textContent = text;
}

function getHeaders(includeTenant = true) {
  const headers = {
    Authorization: `Bearer ${tokenInput.value.trim()}`
  };

  if (includeTenant && tenantSelect.value) {
    headers["X-Tenant-ID"] = tenantSelect.value;
  }

  return headers;
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(data.error?.message || `${response.status} ${response.statusText}`);
  }

  return data;
}

function average(values) {
  if (!values.length) {
    return 0;
  }

  const sum = values.reduce((total, value) => total + value, 0);
  return Math.round(sum / values.length);
}

function renderStats(summary) {
  const cards = [
    ["Tenants", summary.overview.tenantCount],
    ["Jobs", summary.overview.jobCount],
    ["Active", summary.overview.activeJobs],
    ["Retrying", summary.overview.retryingJobs],
    ["Failed", summary.overview.failedJobs],
    ["Running", summary.overview.runningJobs]
  ];

  statsGrid.innerHTML = cards
    .map(
      ([label, value]) => `
        <div class="stat">
          <div class="stat-label">${label}</div>
          <div class="stat-value">${value}</div>
        </div>
      `
    )
    .join("");
}

function renderScheduler(summary) {
  const metrics = summary.scheduler.metrics;
  const instances = summary.scheduler.instances || [];

  schedulerPanel.innerHTML = `
    <div class="scheduler-grid">
      <div class="scheduler-item">
        <strong>Schedulers</strong>
        <span>${summary.scheduler.instanceCount}</span>
      </div>
      <div class="scheduler-item">
        <strong>Leader</strong>
        <span>${summary.scheduler.leader || "No leader yet"}</span>
      </div>
      <div class="scheduler-item">
        <strong>Lease Expires</strong>
        <span>${summary.scheduler.leaderExpiresAt || "n/a"}</span>
      </div>
      <div class="scheduler-item">
        <strong>Leader Elections</strong>
        <span>${metrics.leaderElectionsTotal}</span>
      </div>
      <div class="scheduler-item">
        <strong>Jobs Dispatched</strong>
        <span>${metrics.jobsDispatchedTotal}</span>
      </div>
      <div class="scheduler-item">
        <strong>Retry Attempts</strong>
        <span>${metrics.retryAttemptsTotal}</span>
      </div>
    </div>
    <div class="scheduler-list">
      ${instances.length
        ? instances
          .map(
            (instance) => `
              <div class="scheduler-item ${instance.leader ? "leader" : ""}">
                <strong>${instance.instanceId}</strong>
                <div>Port: ${instance.schedulerPort}</div>
                <div>Status: ${instance.leader ? "Leader" : "Follower"}</div>
                <div>Last Seen: ${instance.lastSeenAt}</div>
              </div>
            `
          )
          .join("")
        : '<div class="empty">No scheduler heartbeats yet.</div>'}
    </div>
  `;
}

function renderTenantOptions(summary) {
  const current = tenantSelect.value || summary.selectedTenant || "";
  const options = summary.tenants
    .map(
      (tenant) => `
        <option value="${tenant.slug}" ${tenant.slug === current ? "selected" : ""}>
          ${tenant.slug} (${tenant.jobCount} jobs)
        </option>
      `
    )
    .join("");

  tenantSelect.innerHTML = options || `<option value="">No tenants</option>`;

  if (!tenantSelect.value && summary.selectedTenant) {
    tenantSelect.value = summary.selectedTenant;
  }
}

function renderJobs(summary) {
  if (!summary.jobs.length) {
    jobsTable.innerHTML = `<div class="empty">No jobs for this tenant yet.</div>`;
    jobSelect.innerHTML = `<option value="">No jobs</option>`;
    renderJobDetails(null);
    historyPanel.textContent = "Pick a job to load history.";
    historyPanel.className = "history-list empty";
    return;
  }

  jobsTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Mode</th>
          <th>Status</th>
          <th>Schedule</th>
          <th>Next Run</th>
          <th>History</th>
          <th>Last Error</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${summary.jobs
          .map(
            (job) => `
              <tr>
                <td>
                  <span class="job-name">${job.name}</span>
                  <span>${job.id}</span>
                </td>
                <td>${job.executionMode}</td>
                <td><span class="pill ${job.status.toLowerCase()}">${job.status}</span></td>
                <td>${job.executionMode === "queue" ? (job.runAt || "immediate") : job.cron}</td>
                <td>${job.nextRunAt || "n/a"}</td>
                <td>${job.historyCount}</td>
                <td>${job.lastError || ""}</td>
                <td><button type="button" class="secondary" data-action="history" data-job-id="${job.id}">History</button></td>
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>
  `;

  const current = jobSelect.value;
  jobSelect.innerHTML = summary.jobs
    .map(
      (job) => `
        <option value="${job.id}" ${job.id === current ? "selected" : ""}>
          ${job.name} - ${job.status}
        </option>
      `
    )
    .join("");

  if (!jobSelect.value) {
    jobSelect.value = summary.jobs[0].id;
  }
}

function renderJobDetails(job) {
  if (!job) {
    jobDetailsPanel.textContent = "Pick a job to inspect its details.";
    jobDetailsPanel.className = "details-grid empty";
    return;
  }

  jobDetailsPanel.className = "details-grid";
  jobDetailsPanel.innerHTML = `
    <div class="detail-card">
      <strong>${job.name}</strong>
      <div>ID: ${job.id}</div>
      <div>Tenant: ${job.tenantId}</div>
      <div>Mode: ${job.executionMode}</div>
      <div>Status: ${job.status}</div>
    </div>
    <div class="detail-card">
      <strong>Schedule</strong>
      <div>${job.executionMode === "queue" ? (job.runAt || "immediate") : job.cron}</div>
      <div>Next Run: ${job.nextRunAt || "n/a"}</div>
      <div>Max Retries: ${job.maxRetries}</div>
      <div>Backoff: ${job.retryBackoffSeconds}s</div>
    </div>
    <div class="detail-card">
      <strong>Payload</strong>
      <pre>${JSON.stringify(job.payload, null, 2)}</pre>
    </div>
  `;
}

async function loadHistory() {
  if (!jobSelect.value || !tenantSelect.value) {
    renderJobDetails(null);
    return;
  }

  const job = dashboardState?.jobs.find((item) => item.id === jobSelect.value) || null;
  renderJobDetails(job);

  try {
    const history = await api(`/jobs/${jobSelect.value}/history?page=1&limit=50`, {
      headers: getHeaders()
    });

    if (!history.items.length) {
      historyPanel.textContent = "No attempts yet.";
      historyPanel.className = "history-list empty";
      return;
    }

    historyPanel.className = "history-list";
    historyPanel.innerHTML = history.items
      .slice()
      .reverse()
      .map(
        (item) => `
          <div class="history-item">
            <strong>Attempt ${item.attempt} - ${item.status}</strong>
            <div>Started: ${item.startedAt}</div>
            <div>Finished: ${item.finishedAt}</div>
            <div>Duration: ${item.durationMs} ms</div>
            <div>Worker: ${item.worker}</div>
            ${item.failureReason ? `<div>Failure: ${item.failureReason}</div>` : ""}
          </div>
        `
      )
      .join("");
  } catch (error) {
    historyPanel.textContent = error.message;
    historyPanel.className = "history-list empty";
  }
}

function syncExecutionModeFields() {
  const isQueue = executionModeSelect.value === "queue";
  jobForm.elements.cron.disabled = isQueue;
  jobForm.elements.cron.required = !isQueue;
  runAtInput.disabled = !isQueue;
  jobForm.elements.cron.placeholder = isQueue ? "Queue jobs do not use cron" : "@every 10s";
}

function showView(viewName) {
  currentView = viewName;
  const isHistory = viewName === "history";
  homeView.hidden = isHistory;
  historyView.hidden = !isHistory;
  homeTab.classList.toggle("active", !isHistory);
  historyTab.classList.toggle("active", isHistory);
}

async function refreshDashboard() {
  try {
    const summary = await api("/dashboard", {
      headers: getHeaders(Boolean(tenantSelect.value))
    });

    dashboardState = summary;
    renderStats(summary);
    renderScheduler(summary);
    renderTenantOptions(summary);
    renderJobs(summary);
    log("Dashboard refreshed.", summary.overview);

    if (currentView === "history") {
      await loadHistory();
    }
  } catch (error) {
    log(`Refresh failed: ${error.message}`);
  }
}

tenantForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(tenantForm);
  const payload = {
    name: String(formData.get("name") || "").trim(),
    slug: String(formData.get("slug") || "").trim(),
    rateLimitPerMinute: Number(formData.get("rateLimitPerMinute") || 120)
  };

  try {
    const created = await api("/tenants", {
      method: "POST",
      headers: {
        ...getHeaders(false),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    tenantForm.reset();
    tenantForm.elements.rateLimitPerMinute.value = "120";
    log("Tenant created.", created);
    await refreshDashboard();
    tenantSelect.value = created.slug;
  } catch (error) {
    log(`Create tenant failed: ${error.message}`, payload);
  }
});

jobForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!tenantSelect.value) {
    log("Pick a tenant before creating a job.");
    return;
  }

  const formData = new FormData(jobForm);
  let parsedPayload;

  try {
    parsedPayload = JSON.parse(String(formData.get("payload") || "{}"));
  } catch (error) {
    log(`Payload JSON is invalid: ${error.message}`);
    return;
  }

  const idempotencyKey = idempotencyInput.value.trim() || nowToken();
  idempotencyInput.value = idempotencyKey;

  const payload = {
    name: String(formData.get("name") || "").trim(),
    executionMode: String(formData.get("executionMode") || "cron"),
    payload: parsedPayload,
    maxRetries: Number(formData.get("maxRetries") || 3),
    retryBackoffSeconds: Number(formData.get("retryBackoffSeconds") || 1)
  };

  if (payload.executionMode === "cron") {
    payload.cron = String(formData.get("cron") || "").trim();
  } else if (formData.get("runAt")) {
    payload.runAt = new Date(String(formData.get("runAt"))).toISOString();
  }

  try {
    const created = await api("/jobs", {
      method: "POST",
      headers: {
        ...getHeaders(),
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey
      },
      body: JSON.stringify(payload)
    });

    idempotencyInput.value = nowToken();
    log("Job created.", created);
    await refreshDashboard();
    jobSelect.value = created.id;
  } catch (error) {
    log(`Create job failed: ${error.message}`, payload);
  }
});

tokenInput.addEventListener("change", () => {
  refreshDashboard();
});

executionModeSelect.addEventListener("change", () => {
  syncExecutionModeFields();
});

homeTab.addEventListener("click", () => {
  showView("home");
});

historyTab.addEventListener("click", () => {
  showView("history");
  loadHistory();
});

viewAllJobsButton.addEventListener("click", () => {
  showView("history");
  loadHistory();
});

tenantSelect.addEventListener("change", () => {
  refreshDashboard();
});

jobSelect.addEventListener("change", () => {
  loadHistory();
});

refreshButton.addEventListener("click", () => {
  refreshDashboard();
});

jobsTable.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action='history']");
  if (!target) {
    return;
  }

  jobSelect.value = target.dataset.jobId;
  showView("history");
  loadHistory();
});

idempotencyInput.value = nowToken();
syncExecutionModeFields();
showView("home");
refreshDashboard();

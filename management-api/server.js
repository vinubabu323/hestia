import "../shared/load-env.js";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { config, devTokens } from "../shared/config.js";
import { computeNextRunAt, validateSchedule } from "../shared/cron.js";
import { sendJson, readJsonBody } from "../shared/http.js";
import { createId } from "../shared/ids.js";
import { getDatabase, withDatabase } from "../shared/store.js";

const publicDir = path.join(process.cwd(), "management-api", "public");
const staticFiles = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "application/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" }
};

function getClaims(request) {
  const authHeader = request.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  return devTokens[token] || null;
}

function sendError(response, status, code, message, details) {
  sendJson(response, status, {
    error: {
      code,
      message,
      status,
      ...(details ? { details } : {})
    }
  });
}

function requireClaims(request, response) {
  const claims = getClaims(request);
  if (!claims) {
    sendError(response, 401, "unauthorized", "Missing or invalid bearer token");
    return null;
  }
  return claims;
}

function requireTenantScope(request, response, claims, options = {}) {
  const tenantId = request.headers["x-tenant-id"];
  if (!tenantId && !options.allowMissing) {
    sendError(response, 400, "validation_error", "X-Tenant-ID header is required", {
      field: "X-Tenant-ID"
    });
    return null;
  }

  if (claims.tenantId && tenantId !== claims.tenantId) {
    sendError(response, 403, "tenant_mismatch", "Token tenant does not match X-Tenant-ID");
    return null;
  }

  return tenantId;
}

function requireRole(response, claims, roles) {
  if (!roles.some((role) => claims.roles.includes(role))) {
    sendError(response, 403, "forbidden", "Token role does not permit this action");
    return false;
  }
  return true;
}

function getIdempotencyKey(request) {
  return request.headers["idempotency-key"] || null;
}

function getIdempotentResponse(job, key, routeKey, requestHash) {
  if (!key || !job.idempotency) {
    return { responsePayload: null, conflict: false };
  }

  const entry = job.idempotency.find((item) => item.key === key && item.routeKey === routeKey);
  if (!entry) {
    return { responsePayload: null, conflict: false };
  }

  if (entry.requestHash !== requestHash) {
    return { responsePayload: null, conflict: true };
  }

  return { responsePayload: entry.responsePayload, conflict: false };
}

function saveIdempotency(job, key, routeKey, requestHash, responsePayload) {
  if (!key) {
    return;
  }

  job.idempotency = job.idempotency || [];
  job.idempotency = job.idempotency.filter((item) => !(item.key === key && item.routeKey === routeKey));
  job.idempotency.push({
    key,
    routeKey,
    requestHash,
    responsePayload
  });
}

function normalizeJobSummary(job) {
  return {
    id: job.id,
    tenantId: job.tenantId,
    name: job.name,
    executionMode: job.executionMode || "cron",
    cron: job.schedule,
    runAt: job.runAt || null,
    payload: job.payload,
    maxRetries: job.maxRetries,
    retryBackoffSeconds: job.retryBackoffSeconds,
    status: job.state,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    nextRunAt: job.nextRunAt
  };
}

function resolveExecutionPlan(body) {
  const executionMode = body.executionMode === "queue" ? "queue" : "cron";

  if (executionMode === "cron") {
    if (!body.cron) {
      throw new Error("cron is required for cron jobs");
    }

    validateSchedule(body.cron);
    return {
      executionMode,
      schedule: body.cron,
      runAt: null,
      nextRunAt: computeNextRunAt(body.cron, new Date()).toISOString()
    };
  }

  const requestedRunAt = body.runAt ? new Date(body.runAt) : new Date();
  if (Number.isNaN(requestedRunAt.getTime())) {
    throw new Error("runAt must be a valid ISO timestamp");
  }

  return {
    executionMode,
    schedule: null,
    runAt: requestedRunAt.toISOString(),
    nextRunAt: requestedRunAt.toISOString()
  };
}

function formatTenantSummary(tenant, database, claims) {
  const jobs = database.jobs.filter((job) => job.tenantId === tenant.slug && !job.deletedAt);
  const activeJobs = jobs.filter((job) => job.state === "ACTIVE").length;
  const failedJobs = jobs.filter((job) => job.state === "FAILED").length;

  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    rateLimitPerMinute: tenant.rateLimitPerMinute,
    roles: claims.roles,
    jobCount: jobs.length,
    activeJobs,
    failedJobs
  };
}

function buildDashboardSummary(claims, tenantId) {
  const database = getDatabase();
  const visibleTenants = claims.tenantId
    ? database.tenants.filter((tenant) => tenant.slug === claims.tenantId)
    : database.tenants;
  const scopedTenantIds = new Set(visibleTenants.map((tenant) => tenant.slug));
  const jobs = database.jobs.filter((job) => scopedTenantIds.has(job.tenantId) && !job.deletedAt);
  const selectedTenant = tenantId || claims.tenantId || visibleTenants[0]?.slug || null;
  const selectedJobs = selectedTenant
    ? jobs.filter((job) => job.tenantId === selectedTenant)
    : jobs;

  return {
    tenants: visibleTenants.map((tenant) => formatTenantSummary(tenant, database, claims)),
    selectedTenant,
    overview: {
      tenantCount: visibleTenants.length,
      jobCount: jobs.length,
      activeJobs: jobs.filter((job) => job.state === "ACTIVE").length,
      retryingJobs: jobs.filter((job) => job.state === "RETRYING").length,
      failedJobs: jobs.filter((job) => job.state === "FAILED").length,
      runningJobs: jobs.filter((job) => job.state === "RUNNING").length
    },
    scheduler: {
      leader: database.scheduler.leader,
      leaderExpiresAt: database.scheduler.leaderExpiresAt,
      instances: (database.scheduler.instances || [])
        .slice()
        .sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
      instanceCount: (database.scheduler.instances || []).length,
      metrics: database.scheduler.metrics
    },
    jobs: selectedJobs
      .slice()
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
      .slice(0, 25)
      .map((job) => ({
        ...normalizeJobSummary(job),
        historyCount: job.history.length,
        lastError: job.lastError
      }))
  };
}

function handleListJobs(response, tenantId, url) {
  const page = Math.max(Number(url.searchParams.get("page") || 1), 1);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);
  const status = url.searchParams.get("status");
  const database = getDatabase();
  let jobs = database.jobs.filter((job) => job.tenantId === tenantId && !job.deletedAt);
  if (status) {
    jobs = jobs.filter((job) => job.state === status);
  }

  const start = (page - 1) * limit;
  const items = jobs.slice(start, start + limit).map((job) => ({
    id: job.id,
    name: job.name,
    executionMode: job.executionMode || "cron",
    cron: job.schedule,
    runAt: job.runAt || null,
    status: job.state,
    nextRunAt: job.nextRunAt
  }));

  sendJson(response, 200, {
    items,
    page,
    limit,
    total: jobs.length
  });
}

function serveStaticAsset(response, pathname) {
  const asset = staticFiles[pathname];
  if (!asset) {
    return false;
  }

  const filePath = path.join(publicDir, asset.file);
  if (!fs.existsSync(filePath)) {
    response.writeHead(500, {
      "Content-Type": "text/plain; charset=utf-8"
    });
    response.end("Missing UI asset");
    return true;
  }

  response.writeHead(200, {
    "Content-Type": asset.type
  });
  response.end(fs.readFileSync(filePath));
  return true;
}

const server = http.createServer(async (request, response) => {
  try {
    await handleRequest(request, response);
  } catch (err) {
    if (!response.headersSent) {
      sendError(response, err.statusCode ?? 500, "internal_error", err.message);
    }
  }
});

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (serveStaticAsset(response, url.pathname)) {
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok", service: "management-api" });
    return;
  }

  const claims = requireClaims(request, response);
  if (!claims) {
    return;
  }

  if (request.method === "GET" && url.pathname === "/dashboard") {
    const tenantId = requireTenantScope(request, response, claims, { allowMissing: true });
    if (tenantId === null && claims.tenantId) {
      return;
    }

    sendJson(response, 200, buildDashboardSummary(claims, tenantId));
    return;
  }

  if (request.method === "GET" && url.pathname === "/tenants") {
    const database = getDatabase();
    const tenants = claims.tenantId
      ? database.tenants.filter((tenant) => tenant.slug === claims.tenantId)
      : database.tenants;

    sendJson(response, 200, {
      items: tenants.map((tenant) => formatTenantSummary(tenant, database, claims)),
      total: tenants.length
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/tenants") {
    if (!requireRole(response, claims, ["admin"])) {
      return;
    }

    const body = await readJsonBody(request);
    if (!body.name || !body.slug) {
      sendError(response, 400, "validation_error", "name and slug are required");
      return;
    }

    const tenant = withDatabase((database) => {
      if (database.tenants.some((item) => item.slug === body.slug)) {
        return null;
      }

      const created = {
        id: createId("tenant"),
        name: body.name,
        slug: body.slug,
        rateLimitPerMinute: body.rateLimitPerMinute || 120,
        createdAt: new Date().toISOString(),
        updatedAt: null,
        webhook: null
      };
      database.tenants.push(created);
      return created;
    });

    if (!tenant) {
      sendError(response, 409, "conflict", "Tenant slug already exists");
      return;
    }

    sendJson(response, 201, tenant);
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/tenants/")) {
    const tenantId = requireTenantScope(request, response, claims);
    if (!tenantId) {
      return;
    }

    const requestedTenant = url.pathname.split("/")[2];
    if (requestedTenant !== tenantId) {
      sendError(response, 403, "tenant_mismatch", "Token tenant does not match X-Tenant-ID");
      return;
    }

    const tenant = getDatabase().tenants.find((item) => item.slug === requestedTenant || item.id === requestedTenant);
    if (!tenant) {
      sendError(response, 404, "not_found", "Tenant not found");
      return;
    }

    sendJson(response, 200, {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      rateLimitPerMinute: tenant.rateLimitPerMinute,
      roles: claims.roles
    });
    return;
  }

  if (request.method === "PATCH" && url.pathname.startsWith("/tenants/")) {
    const tenantId = requireTenantScope(request, response, claims);
    if (!tenantId) {
      return;
    }
    if (!requireRole(response, claims, ["admin"])) {
      return;
    }

    const requestedTenant = url.pathname.split("/")[2];
    if (requestedTenant !== tenantId) {
      sendError(response, 403, "tenant_mismatch", "Token tenant does not match X-Tenant-ID");
      return;
    }

    const body = await readJsonBody(request);
    const tenant = withDatabase((database) => {
      const existing = database.tenants.find((item) => item.slug === requestedTenant || item.id === requestedTenant);
      if (!existing) {
        return null;
      }
      existing.rateLimitPerMinute = body.rateLimitPerMinute || existing.rateLimitPerMinute;
      existing.webhook = body.webhook || existing.webhook;
      existing.updatedAt = new Date().toISOString();
      return existing;
    });

    if (!tenant) {
      sendError(response, 404, "not_found", "Tenant not found");
      return;
    }

    sendJson(response, 200, {
      id: tenant.id,
      rateLimitPerMinute: tenant.rateLimitPerMinute,
      updatedAt: tenant.updatedAt
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/jobs") {
    const tenantId = requireTenantScope(request, response, claims);
    if (!tenantId) {
      return;
    }

    handleListJobs(response, tenantId, url);
    return;
  }

  if (request.method === "POST" && url.pathname === "/jobs") {
    const tenantId = requireTenantScope(request, response, claims);
    if (!tenantId) {
      return;
    }
    if (!requireRole(response, claims, ["admin", "scheduler"])) {
      return;
    }

    const idempotencyKey = getIdempotencyKey(request);
    if (!idempotencyKey) {
      sendError(response, 400, "validation_error", "Idempotency-Key header is required", {
        field: "Idempotency-Key"
      });
      return;
    }

    const body = await readJsonBody(request);
    if (!body.name) {
      sendError(response, 400, "validation_error", "name is required", { field: "name" });
      return;
    }
    if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
      sendError(response, 400, "validation_error", "payload must be a JSON object", { field: "payload" });
      return;
    }

    let executionPlan;
    try {
      executionPlan = resolveExecutionPlan(body);
    } catch (error) {
      sendError(response, 400, "validation_error", error.message, {
        field: body.executionMode === "queue" ? "runAt" : "cron"
      });
      return;
    }

    const requestHash = JSON.stringify(body);
    const result = withDatabase((database) => {
      const existing = database.jobs.find((job) => job.name === body.name && job.tenantId === tenantId && !job.deletedAt);
      if (existing) {
        const idempotent = getIdempotentResponse(existing, idempotencyKey, "create", requestHash);
        if (idempotent.conflict) {
          return { kind: "conflict" };
        }
        if (idempotent.responsePayload) {
          return { kind: "reuse", payload: idempotent.responsePayload };
        }
        // A job with this name already exists but the idempotency key is new.
        // Reject to prevent creating a duplicate.
        return { kind: "conflict" };
      }

      const createdAt = new Date().toISOString();
      const job = {
        id: createId("job"),
        tenantId,
        name: body.name,
        executionMode: executionPlan.executionMode,
        schedule: executionPlan.schedule,
        runAt: executionPlan.runAt,
        payload: body.payload,
        maxRetries: Math.min(Number(body.maxRetries || 3), 10),
        retryBackoffSeconds: Math.max(Number(body.retryBackoffSeconds || 60), 1),
        state: "ACTIVE",
        nextRunAt: executionPlan.nextRunAt,
        retryCount: 0,
        history: [],
        idempotency: [],
        lastError: null,
        lockedUntil: null,
        deletedAt: null,
        createdAt,
        updatedAt: createdAt
      };

      const payload = normalizeJobSummary(job);
      saveIdempotency(job, idempotencyKey, "create", requestHash, payload);
      database.jobs.push(job);
      return { kind: "created", payload };
    });

    if (result.kind === "conflict") {
      sendError(response, 409, "idempotency_conflict", "Idempotency key was already used with a different payload");
      return;
    }

    sendJson(response, result.kind === "reuse" ? 200 : 201, result.payload);
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/jobs/") && url.pathname.endsWith("/history")) {
    const tenantId = requireTenantScope(request, response, claims);
    if (!tenantId) {
      return;
    }

    const jobId = url.pathname.split("/")[2];
    const page = Math.max(Number(url.searchParams.get("page") || 1), 1);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);
    const job = getDatabase().jobs.find((item) => item.id === jobId && !item.deletedAt);
    if (!job || job.tenantId !== tenantId) {
      sendError(response, 404, "not_found", "Job not found");
      return;
    }

    const start = (page - 1) * limit;
    sendJson(response, 200, {
      items: job.history.slice(start, start + limit),
      page,
      limit,
      total: job.history.length
    });
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/jobs/")) {
    const tenantId = requireTenantScope(request, response, claims);
    if (!tenantId) {
      return;
    }

    const jobId = url.pathname.split("/")[2];
    const job = getDatabase().jobs.find((item) => item.id === jobId && !item.deletedAt);
    if (!job || job.tenantId !== tenantId) {
      sendError(response, 404, "not_found", "Job not found");
      return;
    }

    sendJson(response, 200, normalizeJobSummary(job));
    return;
  }

  if (request.method === "PATCH" && url.pathname.startsWith("/jobs/")) {
    const tenantId = requireTenantScope(request, response, claims);
    if (!tenantId) {
      return;
    }
    if (!requireRole(response, claims, ["admin", "scheduler"])) {
      return;
    }

    const idempotencyKey = getIdempotencyKey(request);
    if (!idempotencyKey) {
      sendError(response, 400, "validation_error", "Idempotency-Key header is required", {
        field: "Idempotency-Key"
      });
      return;
    }

    const jobId = url.pathname.split("/")[2];
    const body = await readJsonBody(request);
    if (body.executionMode !== undefined && body.executionMode !== "cron" && body.executionMode !== "queue") {
      sendError(response, 400, "validation_error", "executionMode must be cron or queue", {
        field: "executionMode"
      });
      return;
    }

    if (body.cron || body.executionMode === "cron" || body.executionMode === "queue" || body.runAt) {
      try {
        resolveExecutionPlan({
          executionMode: body.executionMode || "cron",
          cron: body.cron,
          runAt: body.runAt
        });
      } catch (error) {
        sendError(response, 400, "validation_error", error.message, {
          field: body.executionMode === "queue" || body.runAt ? "runAt" : "cron"
        });
        return;
      }
    }

    const requestHash = JSON.stringify(body);
    const result = withDatabase((database) => {
      const job = database.jobs.find((item) => item.id === jobId && !item.deletedAt);
      if (!job || job.tenantId !== tenantId) {
        return { kind: "missing" };
      }

      const idempotent = getIdempotentResponse(job, idempotencyKey, "patch", requestHash);
      if (idempotent.conflict) {
        return { kind: "conflict" };
      }
      if (idempotent.responsePayload) {
        return { kind: "reuse", payload: idempotent.responsePayload };
      }

      if (body.cron) {
        const executionPlan = resolveExecutionPlan({
          executionMode: body.executionMode || job.executionMode || "cron",
          cron: body.cron,
          runAt: body.runAt || job.runAt
        });
        job.executionMode = executionPlan.executionMode;
        job.schedule = executionPlan.schedule;
        job.runAt = executionPlan.runAt;
        job.nextRunAt = executionPlan.nextRunAt;
      } else if (body.executionMode === "queue" || body.runAt) {
        const executionPlan = resolveExecutionPlan({
          executionMode: "queue",
          runAt: body.runAt || job.runAt
        });
        job.executionMode = executionPlan.executionMode;
        job.schedule = executionPlan.schedule;
        job.runAt = executionPlan.runAt;
        job.nextRunAt = executionPlan.nextRunAt;
      } else if (body.executionMode === "cron") {
        const executionPlan = resolveExecutionPlan({
          executionMode: "cron",
          cron: job.schedule
        });
        job.executionMode = executionPlan.executionMode;
        job.schedule = executionPlan.schedule;
        job.runAt = executionPlan.runAt;
        job.nextRunAt = executionPlan.nextRunAt;
      }
      if (body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)) {
        job.payload = body.payload;
      }
      if (body.maxRetries !== undefined) {
        job.maxRetries = Math.min(Number(body.maxRetries), 10);
      }
      if (body.retryBackoffSeconds !== undefined) {
        job.retryBackoffSeconds = Math.max(Number(body.retryBackoffSeconds), 1);
      }
      job.updatedAt = new Date().toISOString();

      const payload = {
        id: job.id,
        executionMode: job.executionMode || "cron",
        cron: job.schedule,
        runAt: job.runAt || null,
        maxRetries: job.maxRetries,
        updatedAt: job.updatedAt
      };

      saveIdempotency(job, idempotencyKey, "patch", requestHash, payload);
      return { kind: "updated", payload };
    });

    if (result.kind === "missing") {
      sendError(response, 404, "not_found", "Job not found");
      return;
    }
    if (result.kind === "conflict") {
      sendError(response, 409, "idempotency_conflict", "Idempotency key was already used with a different payload");
      return;
    }

    sendJson(response, 200, result.payload);
    return;
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/jobs/")) {
    const tenantId = requireTenantScope(request, response, claims);
    if (!tenantId) {
      return;
    }
    if (!requireRole(response, claims, ["admin", "scheduler"])) {
      return;
    }

    const jobId = url.pathname.split("/")[2];
    const payload = withDatabase((database) => {
      const job = database.jobs.find((item) => item.id === jobId && !item.deletedAt);
      if (!job || job.tenantId !== tenantId) {
        return null;
      }

      job.deletedAt = new Date().toISOString();
      job.state = "DELETED";
      job.updatedAt = job.deletedAt;
      return {
        id: job.id,
        deleted: true
      };
    });

    if (!payload) {
      sendError(response, 404, "not_found", "Job not found");
      return;
    }

    sendJson(response, 200, payload);
    return;
  }

  sendError(response, 404, "not_found", "Route not found");
}

server.listen(config.apiPort, () => {
  console.log(`management-api listening on http://127.0.0.1:${config.apiPort}`);
});

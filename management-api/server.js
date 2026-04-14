import "../shared/load-env.js";
import http from "node:http";
import { config, devTokens } from "../shared/config.js";
import { computeNextRunAt, validateSchedule } from "../shared/cron.js";
import { sendJson, readJsonBody } from "../shared/http.js";
import { createId } from "../shared/ids.js";
import { getDatabase, withDatabase } from "../shared/store.js";

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
    cron: job.schedule,
    payload: job.payload,
    maxRetries: job.maxRetries,
    retryBackoffSeconds: job.retryBackoffSeconds,
    status: job.state,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    nextRunAt: job.nextRunAt
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
    cron: job.schedule,
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

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok", service: "management-api" });
    return;
  }

  const claims = requireClaims(request, response);
  if (!claims) {
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

    try {
      validateSchedule(body.cron);
    } catch (error) {
      sendError(response, 400, "validation_error", error.message, { field: "cron" });
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
      }

      const createdAt = new Date().toISOString();
      const job = {
        id: createId("job"),
        tenantId,
        name: body.name,
        schedule: body.cron,
        payload: body.payload,
        maxRetries: Math.min(Number(body.maxRetries || 3), 10),
        retryBackoffSeconds: Math.max(Number(body.retryBackoffSeconds || 60), 1),
        state: "ACTIVE",
        nextRunAt: computeNextRunAt(body.cron, new Date()).toISOString(),
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
    if (body.cron) {
      try {
        validateSchedule(body.cron);
      } catch (error) {
        sendError(response, 400, "validation_error", error.message, { field: "cron" });
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
        job.schedule = body.cron;
        job.nextRunAt = computeNextRunAt(body.cron, new Date()).toISOString();
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
        cron: job.schedule,
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
});

server.listen(config.apiPort, () => {
  console.log(`management-api listening on http://127.0.0.1:${config.apiPort}`);
});

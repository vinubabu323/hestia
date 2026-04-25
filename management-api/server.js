import "../shared/load-env.js";
import http from "node:http";
import net from "node:net";
import { config, devTokens } from "../shared/config.js";
import { computeNextRunAt, validateSchedule } from "../shared/cron.js";
import { sendJson, readJsonBody } from "../shared/http.js";
import { createId } from "../shared/ids.js";
import { getDb } from "../shared/db.js";
import { runMigrations } from "./migrate.js";

const schedulerLeaderKey = "scheduler:leader";
const schedulerLeaderElectionsKey = "scheduler:metrics:leader_elections_total";
const schedulerInstanceKeyPattern = "scheduler:instance:*";

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

async function formatTenantSummary(tenant, claims) {
  const sql = getDb();
  const [{ active_jobs, failed_jobs, job_count }] = await sql`
    SELECT
      COUNT(*)                                          AS job_count,
      COUNT(*) FILTER (WHERE state = 'ACTIVE')          AS active_jobs,
      COUNT(*) FILTER (WHERE state = 'FAILED')          AS failed_jobs
    FROM jobs
    WHERE tenant_id = ${tenant.slug} AND deleted_at IS NULL
  `;
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    rateLimitPerMinute: tenant.rate_limit_per_minute,
    roles: claims.roles,
    jobCount: Number(job_count),
    activeJobs: Number(active_jobs),
    failedJobs: Number(failed_jobs)
  };
}

async function buildDashboardSummary(claims, tenantId) {
  const sql = getDb();
  const tenantRows = claims.tenantId
    ? await sql`SELECT * FROM tenants WHERE slug = ${claims.tenantId}`
    : await sql`SELECT * FROM tenants`;

  const selectedTenant = tenantId || claims.tenantId || tenantRows[0]?.slug || null;
  const tenantSlugs = tenantRows.map((t) => t.slug);
  const scopedTenantSlugs = selectedTenant ? tenantSlugs.filter((slug) => slug === selectedTenant) : tenantSlugs;

  const jobs = scopedTenantSlugs.length > 0
    ? await sql`
        SELECT
          jobs.*,
          COALESCE(job_history.history_count, 0) AS history_count
        FROM jobs
        LEFT JOIN (
          SELECT job_id, COUNT(*) AS history_count
          FROM event_log
          GROUP BY job_id
        ) AS job_history ON job_history.job_id = jobs.id
        WHERE tenant_id = ANY(${scopedTenantSlugs})
          AND deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 25
      `
    : [];

  const counts = scopedTenantSlugs.length > 0
    ? await sql`
        SELECT
          COUNT(*)                                              AS job_count,
          COUNT(*) FILTER (WHERE state = 'ACTIVE')              AS active_jobs,
          COUNT(*) FILTER (WHERE state = 'RETRYING')            AS retrying_jobs,
          COUNT(*) FILTER (WHERE state = 'FAILED')              AS failed_jobs,
          COUNT(*) FILTER (WHERE state = 'RUNNING')             AS running_jobs
        FROM jobs
        WHERE tenant_id = ANY(${scopedTenantSlugs}) AND deleted_at IS NULL
      `
    : [{ job_count: 0, active_jobs: 0, retrying_jobs: 0, failed_jobs: 0, running_jobs: 0 }];

  const tenants = await Promise.all(tenantRows.map((t) => formatTenantSummary(t, claims)));
  const scheduler = await readSchedulerSummary(sql, scopedTenantSlugs);

  return {
    tenants,
    selectedTenant,
    overview: {
      tenantCount: tenantRows.length,
      jobCount: Number(counts[0].job_count),
      activeJobs: Number(counts[0].active_jobs),
      retryingJobs: Number(counts[0].retrying_jobs),
      failedJobs: Number(counts[0].failed_jobs),
      runningJobs: Number(counts[0].running_jobs)
    },
    scheduler,
    jobs: jobs.map((job) => ({
      id: job.id,
      tenantId: job.tenant_id,
      name: job.name,
      executionMode: job.execution_mode,
      cron: job.schedule,
      runAt: job.run_at,
      payload: job.payload,
      maxRetries: job.max_retries,
      retryBackoffSeconds: job.retry_backoff_seconds,
      status: job.state,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      nextRunAt: job.next_run_at,
      historyCount: Number(job.history_count),
      lastError: job.last_error
    }))
  };
}

async function readSchedulerSummary(sql, tenantSlugs) {
  const metrics = await readSchedulerMetrics(sql, tenantSlugs);

  try {
    const leader = await readRedisLeader();
    const instances = await readRedisSchedulerInstances(leader.instanceId);
    const leaderExpiresAt = leader.ttlMs > 0
      ? new Date(Date.now() + leader.ttlMs).toISOString()
      : null;

    return {
      leader: leader.instanceId || null,
      leaderExpiresAt,
      instances,
      instanceCount: instances.length,
      metrics
    };
  } catch {
    return { leader: null, leaderExpiresAt: null, instances: [], instanceCount: 0, metrics };
  }
}

async function readRedisLeader() {
  const replies = await sendRedisCommands(getRedisConnection(), [
    ["GET", schedulerLeaderKey],
    ["PTTL", schedulerLeaderKey],
    ["GET", schedulerLeaderElectionsKey]
  ]);

  return {
    instanceId: replies[0] || null,
    ttlMs: typeof replies[1] === "number" ? replies[1] : -1,
    leaderElectionsTotal: Number(replies[2] || 0)
  };
}

async function readRedisSchedulerInstances(leaderInstanceId) {
  const connection = getRedisConnection();
  const keys = await sendRedisCommands(connection, [
    ["KEYS", schedulerInstanceKeyPattern]
  ]);
  const instanceKeys = Array.isArray(keys[0]) ? keys[0].sort() : [];
  if (instanceKeys.length === 0) {
    return [];
  }

  const payloads = await sendRedisCommands(
    connection,
    instanceKeys.map((key) => ["GET", key])
  );

  return payloads
    .map((payload) => {
      if (!payload) return null;
      try {
        const parsed = JSON.parse(payload);
        return {
          instanceId: parsed.instanceId,
          schedulerPort: Number(parsed.schedulerPort || config.schedulerPort),
          leader: parsed.instanceId === leaderInstanceId,
          lastSeenAt: parsed.lastSeenAt || null
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.leader && !right.leader) return -1;
      if (!left.leader && right.leader) return 1;
      return left.instanceId.localeCompare(right.instanceId);
    });
}

async function readSchedulerMetrics(sql, tenantSlugs) {
  const eventScope = tenantSlugs.length > 0
    ? await sql`
        SELECT
          COUNT(*) AS jobs_dispatched_total,
          COUNT(*) FILTER (WHERE attempt > 1) AS retry_attempts_total
        FROM event_log
        WHERE tenant_id = ANY(${tenantSlugs})
      `
    : [{ jobs_dispatched_total: 0, retry_attempts_total: 0 }];

  let leaderElectionsTotal = 0;
  try {
    const leader = await readRedisLeader();
    leaderElectionsTotal = Number(leader.leaderElectionsTotal || 0);
  } catch {
    leaderElectionsTotal = 0;
  }

  return {
    leaderElectionsTotal,
    jobsDispatchedTotal: Number(eventScope[0].jobs_dispatched_total),
    retryAttemptsTotal: Number(eventScope[0].retry_attempts_total)
  };
}

function sendRedisCommands(connection, commands) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: connection.host, port: connection.port });
    const replies = [];
    let buffer = Buffer.alloc(0);
    const queue = [];

    if (connection.password) {
      queue.push(["AUTH", connection.password]);
    }
    if (connection.dbIndex > 0) {
      queue.push(["SELECT", String(connection.dbIndex)]);
    }
    queue.push(...commands);

    socket.setTimeout(2000);

    socket.on("connect", () => {
      socket.write(queue.map(encodeRedisCommand).join(""));
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const parsed = parseRedisReply(buffer);
        if (!parsed) break;
        buffer = parsed.rest;
        replies.push(parsed.value);
        if (replies.length === queue.length) {
          socket.end();
          resolve(replies.slice(queue.length - commands.length));
          return;
        }
      }
    });

    socket.on("timeout", () => {
      socket.destroy(new Error("Redis request timed out"));
    });

    socket.on("error", reject);
  });
}

function encodeRedisCommand(parts) {
  return `*${parts.length}\r\n${parts.map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join("")}`;
}

function parseRedisReply(buffer) {
  if (buffer.length === 0) return null;

  const type = String.fromCharCode(buffer[0]);
  if (type === "+" || type === "-" || type === ":") {
    const end = buffer.indexOf("\r\n");
    if (end === -1) return null;
    const raw = buffer.subarray(1, end).toString();
    if (type === "-") {
      throw new Error(raw);
    }
    return {
      value: type === ":" ? Number(raw) : raw,
      rest: buffer.subarray(end + 2)
    };
  }

  if (type === "$") {
    const end = buffer.indexOf("\r\n");
    if (end === -1) return null;
    const size = Number(buffer.subarray(1, end).toString());
    if (size === -1) {
      return { value: null, rest: buffer.subarray(end + 2) };
    }
    const bodyStart = end + 2;
    const bodyEnd = bodyStart + size;
    if (buffer.length < bodyEnd + 2) return null;
    return {
      value: buffer.subarray(bodyStart, bodyEnd).toString(),
      rest: buffer.subarray(bodyEnd + 2)
    };
  }

  if (type === "*") {
    const end = buffer.indexOf("\r\n");
    if (end === -1) return null;
    const count = Number(buffer.subarray(1, end).toString());
    if (count === -1) {
      return { value: null, rest: buffer.subarray(end + 2) };
    }

    let rest = buffer.subarray(end + 2);
    const items = [];
    for (let index = 0; index < count; index += 1) {
      const parsed = parseRedisReply(rest);
      if (!parsed) return null;
      items.push(parsed.value);
      rest = parsed.rest;
    }

    return { value: items, rest };
  }

  throw new Error(`Unsupported Redis reply type: ${type}`);
}

function getRedisConnection() {
  const redisUrl = new URL(config.redisUrl);
  return {
    host: redisUrl.hostname || "127.0.0.1",
    port: Number(redisUrl.port || 6379),
    password: redisUrl.password ? decodeURIComponent(redisUrl.password) : null,
    dbIndex: redisUrl.pathname && redisUrl.pathname !== "/"
      ? Number(redisUrl.pathname.slice(1))
      : 0
  };
}

async function handleListJobs(response, tenantId, url) {
  const sql = getDb();
  const page = Math.max(Number(url.searchParams.get("page") || 1), 1);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);
  const status = url.searchParams.get("status");
  const offset = (page - 1) * limit;

  const jobs = status
    ? await sql`SELECT * FROM jobs WHERE tenant_id = ${tenantId} AND state = ${status} AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}`
    : await sql`SELECT * FROM jobs WHERE tenant_id = ${tenantId} AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}`;

  const [{ total }] = status
    ? await sql`SELECT COUNT(*) AS total FROM jobs WHERE tenant_id = ${tenantId} AND state = ${status} AND deleted_at IS NULL`
    : await sql`SELECT COUNT(*) AS total FROM jobs WHERE tenant_id = ${tenantId} AND deleted_at IS NULL`;

  sendJson(response, 200, {
    items: jobs.map((job) => ({
      id: job.id,
      name: job.name,
      executionMode: job.execution_mode,
      cron: job.schedule,
      runAt: job.run_at,
      status: job.state,
      nextRunAt: job.next_run_at
    })),
    page,
    limit,
    total: Number(total)
  });
}

function setCorsHeaders(response) {
  // Dev tool only — wildcard origin is intentional for local development
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, X-Tenant-ID, Idempotency-Key, Content-Type"
  );
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
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
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);

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
    if (tenantId === null && claims.tenantId) return;
    sendJson(response, 200, await buildDashboardSummary(claims, tenantId));
    return;
  }

  if (request.method === "GET" && url.pathname === "/tenants") {
    const sql = getDb();
    const tenants = claims.tenantId
      ? await sql`SELECT * FROM tenants WHERE slug = ${claims.tenantId}`
      : await sql`SELECT * FROM tenants`;

    const items = await Promise.all(tenants.map((t) => formatTenantSummary(t, claims)));
    sendJson(response, 200, { items, total: items.length });
    return;
  }

  if (request.method === "POST" && url.pathname === "/tenants") {
    if (!requireRole(response, claims, ["admin"])) return;
    const body = await readJsonBody(request);
    if (!body.name || !body.slug) {
      sendError(response, 400, "validation_error", "name and slug are required");
      return;
    }
    const sql = getDb();
    const id = createId("tenant");
    try {
      const [tenant] = await sql`
        INSERT INTO tenants (id, name, slug, rate_limit_per_minute)
        VALUES (${id}, ${body.name}, ${body.slug}, ${body.rateLimitPerMinute || 120})
        RETURNING *
      `;
      sendJson(response, 201, tenant);
    } catch (err) {
      if (err.code === "23505") {
        sendError(response, 409, "conflict", "Tenant slug already exists");
        return;
      }
      throw err;
    }
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/tenants/")) {
    const tenantId = requireTenantScope(request, response, claims);
    if (!tenantId) return;
    const requestedTenant = url.pathname.split("/")[2];
    if (requestedTenant !== tenantId) {
      sendError(response, 403, "tenant_mismatch", "Token tenant does not match X-Tenant-ID");
      return;
    }
    const sql = getDb();
    const [tenant] = await sql`SELECT * FROM tenants WHERE slug = ${requestedTenant} OR id = ${requestedTenant}`;
    if (!tenant) { sendError(response, 404, "not_found", "Tenant not found"); return; }
    sendJson(response, 200, {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      rateLimitPerMinute: tenant.rate_limit_per_minute,
      roles: claims.roles
    });
    return;
  }

  if (request.method === "PATCH" && url.pathname.startsWith("/tenants/")) {
    const tenantId = requireTenantScope(request, response, claims);
    if (!tenantId) return;
    if (!requireRole(response, claims, ["admin"])) return;
    const requestedTenant = url.pathname.split("/")[2];
    if (requestedTenant !== tenantId) {
      sendError(response, 403, "tenant_mismatch", "Token tenant does not match X-Tenant-ID");
      return;
    }
    const body = await readJsonBody(request);
    const sql = getDb();
    const updates = {};
    if (body.rateLimitPerMinute) updates.rate_limit_per_minute = body.rateLimitPerMinute;
    if (body.webhook?.url) updates.webhook_url = body.webhook.url;
    if (body.webhook?.signingSecretRef) updates.webhook_secret_ref = body.webhook.signingSecretRef;
    updates.updated_at = new Date();
    const [tenant] = await sql`
      UPDATE tenants SET ${sql(updates)} WHERE slug = ${requestedTenant} OR id = ${requestedTenant} RETURNING *
    `;
    if (!tenant) { sendError(response, 404, "not_found", "Tenant not found"); return; }
    sendJson(response, 200, { id: tenant.id, rateLimitPerMinute: tenant.rate_limit_per_minute, updatedAt: tenant.updated_at });
    return;
  }

  if (request.method === "GET" && url.pathname === "/jobs") {
    const tenantId = requireTenantScope(request, response, claims);
    if (!tenantId) return;
    await handleListJobs(response, tenantId, url);
    return;
  }

  if (request.method === "POST" && url.pathname === "/jobs") {
    const tenantId = requireTenantScope(request, response, claims);
    if (!tenantId) return;
    if (!requireRole(response, claims, ["admin", "scheduler"])) return;

    const idempotencyKey = getIdempotencyKey(request);
    if (!idempotencyKey) {
      sendError(response, 400, "validation_error", "Idempotency-Key header is required", { field: "Idempotency-Key" });
      return;
    }

    const body = await readJsonBody(request);
    if (!body.name) { sendError(response, 400, "validation_error", "name is required", { field: "name" }); return; }
    if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
      sendError(response, 400, "validation_error", "payload must be a JSON object", { field: "payload" }); return;
    }

    let executionPlan;
    try { executionPlan = resolveExecutionPlan(body); }
    catch (error) {
      sendError(response, 400, "validation_error", error.message, { field: body.executionMode === "queue" ? "runAt" : "cron" });
      return;
    }

    const sql = getDb();
    const requestHash = JSON.stringify(body);

    const [existing] = await sql`SELECT * FROM jobs WHERE name = ${body.name} AND tenant_id = ${tenantId} AND deleted_at IS NULL`;
    if (existing) {
      const [idem] = await sql`SELECT * FROM idempotency_log WHERE key = ${idempotencyKey} AND route_key = ${'create'}`;
      if (idem) {
        if (idem.request_hash !== requestHash) {
          sendError(response, 409, "idempotency_conflict", "Idempotency key was already used with a different payload");
          return;
        }
        sendJson(response, 200, idem.response_payload);
        return;
      }
      sendError(response, 409, "conflict", "A job with this name already exists");
      return;
    }

    const id = createId("job");
    const now = new Date().toISOString();
    const [job] = await sql`
      INSERT INTO jobs (id, tenant_id, name, execution_mode, schedule, run_at, payload, max_retries, retry_backoff_seconds, state, next_run_at, created_at, updated_at)
      VALUES (
        ${id}, ${tenantId}, ${body.name},
        ${executionPlan.executionMode}, ${executionPlan.schedule}, ${executionPlan.runAt},
        ${JSON.stringify(body.payload)}, ${Math.min(Number(body.maxRetries || 3), 10)},
        ${Math.max(Number(body.retryBackoffSeconds || 60), 1)},
        'ACTIVE', ${executionPlan.nextRunAt}, ${now}, ${now}
      )
      RETURNING *
    `;

    const payload = {
      id: job.id, tenantId: job.tenant_id, name: job.name,
      executionMode: job.execution_mode, cron: job.schedule, runAt: job.run_at,
      payload: job.payload, maxRetries: job.max_retries,
      retryBackoffSeconds: job.retry_backoff_seconds,
      status: job.state, createdAt: job.created_at, updatedAt: job.updated_at,
      nextRunAt: job.next_run_at
    };

    await sql`
      INSERT INTO idempotency_log (key, route_key, request_hash, response_payload)
      VALUES (${idempotencyKey}, ${'create'}, ${requestHash}, ${JSON.stringify(payload)})
      ON CONFLICT (key, route_key) DO NOTHING
    `;

    sendJson(response, 201, payload);
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/jobs/") && url.pathname.endsWith("/history")) {
    const tenantId = requireTenantScope(request, response, claims);
    if (!tenantId) return;
    const jobId = url.pathname.split("/")[2];
    const page = Math.max(Number(url.searchParams.get("page") || 1), 1);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);
    const offset = (page - 1) * limit;
    const sql = getDb();
    const [job] = await sql`SELECT id, tenant_id FROM jobs WHERE id = ${jobId} AND deleted_at IS NULL`;
    if (!job || job.tenant_id !== tenantId) { sendError(response, 404, "not_found", "Job not found"); return; }
    const items = await sql`SELECT * FROM event_log WHERE job_id = ${jobId} ORDER BY attempt DESC LIMIT ${limit} OFFSET ${offset}`;
    const [{ total }] = await sql`SELECT COUNT(*) AS total FROM event_log WHERE job_id = ${jobId}`;
    sendJson(response, 200, { items, page, limit, total: Number(total) });
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/jobs/")) {
    const tenantId = requireTenantScope(request, response, claims);
    if (!tenantId) return;
    const jobId = url.pathname.split("/")[2];
    const sql = getDb();
    const [job] = await sql`SELECT * FROM jobs WHERE id = ${jobId} AND deleted_at IS NULL`;
    if (!job || job.tenant_id !== tenantId) { sendError(response, 404, "not_found", "Job not found"); return; }
    sendJson(response, 200, {
      id: job.id, tenantId: job.tenant_id, name: job.name,
      executionMode: job.execution_mode, cron: job.schedule, runAt: job.run_at,
      payload: job.payload, maxRetries: job.max_retries,
      retryBackoffSeconds: job.retry_backoff_seconds,
      status: job.state, createdAt: job.created_at, updatedAt: job.updated_at,
      nextRunAt: job.next_run_at
    });
    return;
  }

  if (request.method === "PATCH" && url.pathname.startsWith("/jobs/")) {
    const tenantId = requireTenantScope(request, response, claims);
    if (!tenantId) return;
    if (!requireRole(response, claims, ["admin", "scheduler"])) return;
    const idempotencyKey = getIdempotencyKey(request);
    if (!idempotencyKey) {
      sendError(response, 400, "validation_error", "Idempotency-Key header is required", { field: "Idempotency-Key" }); return;
    }
    const jobId = url.pathname.split("/")[2];
    const body = await readJsonBody(request);
    const sql = getDb();
    const [job] = await sql`SELECT * FROM jobs WHERE id = ${jobId} AND deleted_at IS NULL`;
    if (!job || job.tenant_id !== tenantId) { sendError(response, 404, "not_found", "Job not found"); return; }

    const requestHash = JSON.stringify(body);
    const [idem] = await sql`SELECT * FROM idempotency_log WHERE key = ${idempotencyKey} AND route_key = ${'patch'}`;
    if (idem) {
      if (idem.request_hash !== requestHash) {
        sendError(response, 409, "idempotency_conflict", "Idempotency key was already used with a different payload"); return;
      }
      sendJson(response, 200, idem.response_payload);
      return;
    }

    const updates = { updated_at: new Date() };
    if (body.cron || body.executionMode || body.runAt) {
      let plan;
      try { plan = resolveExecutionPlan({ executionMode: body.executionMode || job.execution_mode, cron: body.cron || job.schedule, runAt: body.runAt || job.run_at }); }
      catch (error) { sendError(response, 400, "validation_error", error.message, { field: "cron" }); return; }
      updates.execution_mode = plan.executionMode;
      updates.schedule = plan.schedule;
      updates.run_at = plan.runAt;
      updates.next_run_at = plan.nextRunAt;
    }
    if (body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)) updates.payload = JSON.stringify(body.payload);
    if (body.maxRetries !== undefined) updates.max_retries = Math.min(Number(body.maxRetries), 10);
    if (body.retryBackoffSeconds !== undefined) updates.retry_backoff_seconds = Math.max(Number(body.retryBackoffSeconds), 1);

    const [updated] = await sql`UPDATE jobs SET ${sql(updates)} WHERE id = ${jobId} RETURNING *`;
    const payload = {
      id: updated.id, executionMode: updated.execution_mode, cron: updated.schedule,
      runAt: updated.run_at, maxRetries: updated.max_retries, updatedAt: updated.updated_at
    };
    await sql`INSERT INTO idempotency_log (key, route_key, request_hash, response_payload) VALUES (${idempotencyKey}, ${'patch'}, ${requestHash}, ${JSON.stringify(payload)}) ON CONFLICT (key, route_key) DO NOTHING`;
    sendJson(response, 200, payload);
    return;
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/jobs/")) {
    const tenantId = requireTenantScope(request, response, claims);
    if (!tenantId) return;
    if (!requireRole(response, claims, ["admin", "scheduler"])) return;
    const jobId = url.pathname.split("/")[2];
    const sql = getDb();
    const [job] = await sql`
      UPDATE jobs SET deleted_at = NOW(), state = 'DELETED', updated_at = NOW()
      WHERE id = ${jobId} AND tenant_id = ${tenantId} AND deleted_at IS NULL
      RETURNING id
    `;
    if (!job) { sendError(response, 404, "not_found", "Job not found"); return; }
    sendJson(response, 200, { id: job.id, deleted: true });
    return;
  }

  sendError(response, 404, "not_found", "Route not found");
}

const sql = getDb();
runMigrations(sql)
  .then(() => {
    server.listen(config.apiPort, () => {
      console.log(`management-api listening on http://127.0.0.1:${config.apiPort}`);
    });
  })
  .catch((err) => {
    console.error("migration failed:", err);
    process.exit(1);
  });

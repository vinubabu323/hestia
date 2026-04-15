import "../shared/load-env.js";
import http from "node:http";
import os from "node:os";
import { config } from "../shared/config.js";
import { computeNextRunAt, computeRetryDelayMs } from "../shared/cron.js";
import { sendJson, postJson } from "../shared/http.js";
import { createId } from "../shared/ids.js";
import { getDatabase, withDatabase } from "../shared/store.js";

const instanceId = `${os.hostname()}-${process.pid}`;
let isLeader = false;

function average(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function nowIso() {
  return new Date().toISOString();
}

function acquireOrRenewLeadership() {
  const now = Date.now();

  const state = withDatabase((database) => {
    const leaderExpiresAt = database.scheduler.leaderExpiresAt
      ? new Date(database.scheduler.leaderExpiresAt).getTime()
      : 0;

    if (
      !database.scheduler.leader ||
      leaderExpiresAt <= now ||
      database.scheduler.leader === instanceId
    ) {
      const wasDifferentLeader = database.scheduler.leader !== instanceId;
      database.scheduler.leader = instanceId;
      database.scheduler.leaderExpiresAt = new Date(now + config.leaderTtlMs).toISOString();
      if (wasDifferentLeader) {
        database.scheduler.metrics.leaderElectionsTotal += 1;
      }

      return {
        leader: instanceId
      };
    }

    return {
      leader: database.scheduler.leader
    };
  });

  isLeader = state.leader === instanceId;
  return isLeader;
}

async function dispatchJob(jobId) {
  const lease = withDatabase((database) => {
    const job = database.jobs.find((item) => item.id === jobId && !item.deletedAt);
    if (!job) {
      return null;
    }

    if (job.lockedUntil && new Date(job.lockedUntil).getTime() > Date.now()) {
      return null;
    }

    job.lockedUntil = new Date(Date.now() + config.dispatchTimeoutMs).toISOString();
    job.state = "RUNNING";
    job.updatedAt = nowIso();

    return {
      id: job.id,
      tenantId: job.tenantId,
      name: job.name,
      payload: job.payload,
      schedule: job.schedule,
      attempt: job.retryCount + 1,
      maxRetries: job.maxRetries,
      retryBackoffSeconds: job.retryBackoffSeconds
    };
  });

  if (!lease) {
    return;
  }

  const startedAt = Date.now();
  const idempotencyKey = createId("attempt");

  try {
    const result = await postJson(
      `${config.workerUrl}/execute`,
      {
        idempotencyKey,
        job: lease
      },
      config.dispatchTimeoutMs
    );

    if (!result.ok) {
      throw new Error(result.json?.error?.message || `worker returned ${result.status}`);
    }

    const finishedAt = Date.now();
    const durationMs = finishedAt - startedAt;

    withDatabase((database) => {
      const job = database.jobs.find((item) => item.id === jobId && !item.deletedAt);
      if (!job) {
        return;
      }

      job.history.push({
        attempt: lease.attempt,
        status: "SUCCESS",
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        durationMs,
        worker: result.json.worker,
        idempotencyKey
      });
      job.retryCount = 0;
      job.state = "ACTIVE";
      job.nextRunAt = computeNextRunAt(job.schedule, new Date(finishedAt)).toISOString();
      job.lastError = null;
      job.lockedUntil = null;
      job.updatedAt = nowIso();

      database.scheduler.metrics.jobsDispatchedTotal += 1;
      database.scheduler.metrics.dispatchDurationsMs.push(durationMs);
      database.scheduler.metrics.dispatchDurationsMs = database.scheduler.metrics.dispatchDurationsMs.slice(-100);
    });
  } catch (error) {
    const finishedAt = Date.now();
    const durationMs = finishedAt - startedAt;

    withDatabase((database) => {
      const job = database.jobs.find((item) => item.id === jobId && !item.deletedAt);
      if (!job) {
        return;
      }

      const nextAttempt = job.retryCount + 1;
      const canRetry = nextAttempt < job.maxRetries;

      job.history.push({
        attempt: lease.attempt,
        status: canRetry ? "RETRYING" : "FAILED",
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        durationMs,
        worker: "mock-worker",
        failureReason: error.message,
        idempotencyKey
      });

      if (canRetry) {
        job.retryCount = nextAttempt;
        job.state = "RETRYING";
        job.nextRunAt = new Date(
          Date.now() + computeRetryDelayMs(job.retryBackoffSeconds, nextAttempt)
        ).toISOString();
        database.scheduler.metrics.retryAttemptsTotal += 1;
      } else {
        job.retryCount = 0;
        job.state = "FAILED";
        job.nextRunAt = computeNextRunAt(job.schedule, new Date(finishedAt)).toISOString();
      }

      job.lastError = error.message;
      job.lockedUntil = null;
      job.updatedAt = nowIso();
      database.scheduler.metrics.dispatchDurationsMs.push(durationMs);
      database.scheduler.metrics.dispatchDurationsMs = database.scheduler.metrics.dispatchDurationsMs.slice(-100);
    });
  }
}

async function runTick() {
  const database = getDatabase();
  const dueJobs = database.jobs.filter((job) => {
    if (job.deletedAt) {
      return false;
    }
    if (!["ACTIVE", "FAILED", "RETRYING"].includes(job.state)) {
      return false;
    }
    return new Date(job.nextRunAt).getTime() <= Date.now();
  });

  for (const job of dueJobs) {
    await dispatchJob(job.id);
  }
}

setInterval(() => {
  acquireOrRenewLeadership();
}, config.leaderRenewMs);

setInterval(async () => {
  if (!isLeader && !acquireOrRenewLeadership()) {
    return;
  }

  try {
    await runTick();
  } catch (error) {
    console.error("[scheduler] tick failed", error);
  }
}, config.schedulerTickMs);

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const database = getDatabase();

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      status: "ok",
      service: "scheduler",
      leader: isLeader,
      instanceId
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/metrics") {
    const metrics = database.scheduler.metrics;
    response.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8"
    });
    response.end(
      [
        `scheduler_leader_elections_total ${metrics.leaderElectionsTotal}`,
        `scheduler_jobs_dispatched_total ${metrics.jobsDispatchedTotal}`,
        `scheduler_retry_attempts_total ${metrics.retryAttemptsTotal}`,
        `scheduler_dispatch_duration_ms_avg ${average(metrics.dispatchDurationsMs)}`
      ].join("\n")
    );
    return;
  }

  sendJson(response, 404, {
    error: {
      code: "not_found",
      message: "Route not found",
      status: 404
    }
  });
});

server.listen(config.schedulerPort, () => {
  acquireOrRenewLeadership();
  console.log(`scheduler listening on http://127.0.0.1:${config.schedulerPort}`);
});

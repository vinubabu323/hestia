import "../../shared/load-env.js";
import http from "node:http";
import { config } from "../../shared/config.js";
import { sendJson, readJsonBody } from "../../shared/http.js";

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      status: "ok",
      service: "mock-worker"
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/execute") {
    const body = await readJsonBody(request);
    const job = body.job;

    // Allow easy failure-path testing without changing the worker code.
    if (job.payload?.forceFailure) {
      sendJson(response, 500, {
        error: {
          code: "worker_failed",
          message: "Mock worker failed because payload.forceFailure was true",
          status: 500
        }
      });
      return;
    }

    sendJson(response, 200, {
      worker: "mock-worker",
      receivedAt: new Date().toISOString(),
      output: {
        tenantId: job.tenantId,
        jobName: job.name,
        echoedPayload: job.payload
      }
    });
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

server.listen(config.workerPort, () => {
  console.log(`mock-worker listening on http://127.0.0.1:${config.workerPort}`);
});

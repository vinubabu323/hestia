import path from "node:path";

const rootDir = process.cwd();

export const config = {
  apiPort: Number(process.env.API_PORT || 3000),
  schedulerPort: Number(process.env.GRPC_PORT || 4000),
  workerPort: Number(process.env.WORKER_PORT || 4100),
  databaseUrl: process.env.DATABASE_URL || "postgresql://hestia:hestia@localhost:5432/hestia_dev",
  workerUrl: process.env.WORKER_URL || `http://127.0.0.1:${process.env.WORKER_PORT || 4100}`,
  schedulerTickMs: Number(process.env.SCHEDULER_TICK_MS || 2000),
  leaderTtlMs: Number(process.env.LEADER_TTL_MS || 10000),
  leaderRenewMs: Number(process.env.LEADER_RENEW_MS || 6000),
  dispatchTimeoutMs: Number(process.env.DISPATCH_TIMEOUT_MS || 8000)
};

export const devTokens = {
  "admin-token": { tenantId: null, roles: ["admin"] },
  "acme-admin-token": { tenantId: "acme-corp", roles: ["admin", "scheduler"] },
  "acme-scheduler-token": { tenantId: "acme-corp", roles: ["scheduler"] },
  "acme-viewer-token": { tenantId: "acme-corp", roles: ["viewer"] }
};

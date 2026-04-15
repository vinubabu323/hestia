import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

function defaultDatabase() {
  return {
    tenants: [],
    jobs: [],
    scheduler: {
      leader: null,
      leaderExpiresAt: null,
      metrics: {
        leaderElectionsTotal: 0,
        jobsDispatchedTotal: 0,
        retryAttemptsTotal: 0,
        dispatchDurationsMs: []
      }
    }
  };
}

function ensureDatabaseFile() {
  const dir = path.dirname(config.dataFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(config.dataFile)) {
    fs.writeFileSync(config.dataFile, JSON.stringify(defaultDatabase(), null, 2));
  }
}

function readDatabase() {
  ensureDatabaseFile();
  return JSON.parse(fs.readFileSync(config.dataFile, "utf8"));
}

function writeDatabase(database) {
  ensureDatabaseFile();
  fs.writeFileSync(config.dataFile, JSON.stringify(database, null, 2));
}

export function withDatabase(mutator) {
  const database = readDatabase();
  const result = mutator(database);
  writeDatabase(database);
  return result;
}

export function getDatabase() {
  return readDatabase();
}

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const lockFile = `${config.dataFile}.lock`;
const lockRetryMs = 25;
const staleLockMs = 30000;
const tmpFile = () => config.dataFile + ".tmp";

function defaultDatabase() {
  return {
    tenants: [],
    jobs: [],
    scheduler: {
      leader: null,
      leaderExpiresAt: null,
      instances: [],
      metrics: {
        leaderElectionsTotal: 0,
        jobsDispatchedTotal: 0,
        retryAttemptsTotal: 0,
        dispatchDurationsMs: []
      }
    }
  };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

function isLockStale() {
  try {
    const stats = fs.statSync(lockFile);
    return Date.now() - stats.mtimeMs > staleLockMs;
  } catch {
    return false;
  }
}

function acquireLock() {
  while (true) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
      fs.closeSync(fd);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      if (isLockStale()) {
        try {
          fs.unlinkSync(lockFile);
          continue;
        } catch (unlinkError) {
          if (unlinkError.code !== "ENOENT") {
            throw unlinkError;
          }
        }
      }

      sleepSync(lockRetryMs);
    }
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(lockFile);
  } catch (error) {
    // ENOENT: already deleted (another process beat us to it) — fine
    // EBUSY: Windows holds the file open momentarily — fine, lock will expire
    if (error.code !== "ENOENT" && error.code !== "EBUSY") {
      throw error;
    }
  }
}

function readDatabase() {
  ensureDatabaseFile();
  return JSON.parse(fs.readFileSync(config.dataFile, "utf8"));
}

function writeDatabase(database) {
  ensureDatabaseFile();
  const tmp = tmpFile();
  fs.writeFileSync(tmp, JSON.stringify(database, null, 2));
  fs.renameSync(tmp, config.dataFile);
}

export function withDatabase(mutator) {
  acquireLock();

  try {
    const database = readDatabase();
    const result = mutator(database);
    writeDatabase(database);
    return result;
  } finally {
    releaseLock();
  }
}

export function getDatabase() {
  acquireLock();

  try {
    return readDatabase();
  } finally {
    releaseLock();
  }
}

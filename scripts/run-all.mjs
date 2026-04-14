import "../shared/load-env.js";
import { spawn } from "node:child_process";

const services = [
  ["api", ["management-api/server.js"]],
  ["scheduler", ["scheduler/server.js"]],
  ["worker", ["workers/mock-worker/server.js"]]
];

const children = services.map(([name, args]) => {
  const child = spawn(process.execPath, args, {
    stdio: ["inherit", "pipe", "pipe"],
    env: process.env
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${name}] ${chunk}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${name}] ${chunk}`);
  });

  child.on("exit", (code) => {
    if (code !== 0) {
      console.error(`[${name}] exited with code ${code}`);
    }
  });

  return child;
});

function shutdown() {
  for (const child of children) {
    child.kill("SIGINT");
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

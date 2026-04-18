import "../shared/load-env.js";
import { spawn } from "node:child_process";

const services = [
  { name: "api", cmd: process.execPath, args: ["management-api/server.js"] },
  { name: "scheduler", cmd: "go", args: ["run", "./scheduler/cmd/scheduler"], shell: true },
  { name: "worker", cmd: process.execPath, args: ["workers/mock-worker/server.js"] },
  { name: "ui", cmd: "npm", args: ["run", "dev"], cwd: "ui", shell: true }
];

const children = services.map(({ name, cmd, args, cwd, shell }) => {
  const child = spawn(cmd, args, {
    stdio: ["inherit", "pipe", "pipe"],
    env: process.env,
    ...(cwd ? { cwd } : {}),
    ...(shell ? { shell: true } : {})
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

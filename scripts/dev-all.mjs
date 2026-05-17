import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const processes = [];
let shuttingDown = false;

function start(name, args) {
  const child = spawn(npmCommand, args, {
    env: process.env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const proc of processes) {
      if (proc !== child && !proc.killed) proc.kill();
    }
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    if (code && code !== 0) {
      console.error(`${name} exited with code ${code}`);
      process.exit(code);
    }
    process.exit(0);
  });

  child.on("error", (error) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Failed to start ${name}: ${error.message}`);
    for (const proc of processes) {
      if (!proc.killed) proc.kill();
    }
    process.exit(1);
  });

  processes.push(child);
}

function stopAll() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const proc of processes) {
    if (!proc.killed) proc.kill();
  }
}

process.on("SIGINT", () => {
  stopAll();
  process.exit(130);
});

process.on("SIGTERM", () => {
  stopAll();
  process.exit(143);
});

start("frontend", ["run", "dev"]);
start("backend", ["run", "backend-dev"]);

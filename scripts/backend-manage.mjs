import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const rootDir = process.cwd();
const backendDir = path.join(rootDir, "backend");
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: node scripts/backend-manage.mjs <manage.py command> [args...]");
  process.exit(1);
}

const venvPython =
  process.platform === "win32"
    ? path.join(backendDir, "venv", "Scripts", "python.exe")
    : path.join(backendDir, "venv", "bin", "python");

const python = existsSync(venvPython) ? venvPython : process.env.PYTHON || "python";

const child = spawn(python, ["manage.py", ...args], {
  cwd: backendDir,
  env: process.env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Failed to start backend command with ${python}: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

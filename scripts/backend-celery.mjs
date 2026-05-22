import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const rootDir = process.cwd();
const backendDir = path.join(rootDir, "backend");
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: node scripts/backend-celery.mjs <celery command> [args...]");
  process.exit(1);
}

const venvCelery =
  process.platform === "win32"
    ? path.join(backendDir, "venv", "Scripts", "celery.exe")
    : path.join(backendDir, "venv", "bin", "celery");

const celery = existsSync(venvCelery) ? venvCelery : process.env.CELERY || "celery";

const child = spawn(celery, ["-A", "skywatch", ...args], {
  cwd: backendDir,
  env: {
    ...process.env,
    DJANGO_SETTINGS_MODULE: process.env.DJANGO_SETTINGS_MODULE || "skywatch.settings",
  },
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Failed to start Celery with ${celery}: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

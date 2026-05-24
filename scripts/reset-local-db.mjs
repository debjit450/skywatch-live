import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const backendDir = path.join(root, "backend");
const sqlitePath = path.join(backendDir, "db.sqlite3");
const args = process.argv.slice(2);
const yes = args.includes("--yes") || process.env.CI === "true";

function run(command, commandArgs, cwd = root) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!yes) {
  console.error("Refusing to reset local data without --yes.");
  console.error("Run: npm run reset-local-db -- --yes");
  process.exit(1);
}

let removedSqlite = false;
if (existsSync(sqlitePath)) {
  rmSync(sqlitePath);
  removedSqlite = true;
  console.log("Removed backend/db.sqlite3.");
}

run("node", ["scripts/backend-manage.mjs", "migrate", "--noinput"]);
if (!removedSqlite) {
  run("node", ["scripts/backend-manage.mjs", "flush", "--noinput"]);
  run("node", ["scripts/backend-manage.mjs", "migrate", "--noinput"]);
}
run("node", ["scripts/backend-manage.mjs", "seed_demo_data"]);
console.log("Local database reset and demo seed complete.");

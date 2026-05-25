import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const checks = [];

function run(command, args = []) {
  const useShell =
    process.platform === "win32" &&
    !command.includes("\\") &&
    !command.includes("/") &&
    !command.endsWith(".exe");
  const result = spawnSync(
    useShell ? [command, ...args].join(" ") : command,
    useShell ? [] : args,
    {
    cwd: root,
    encoding: "utf8",
    shell: useShell,
    },
  );
  return {
    ok: result.status === 0,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
  };
}

function version(command, args, pattern) {
  const result = run(command, args);
  const match = result.output.match(pattern);
  return match ? Number(match[1]) : null;
}

function add(name, ok, detail, fix = "", level = "error") {
  checks.push({ name, ok, detail, fix, level });
}

const nodeMajor = version("node", ["--version"], /v(\d+)/);
add("Node.js", nodeMajor !== null && nodeMajor >= 22, nodeMajor ? `v${nodeMajor}` : "not found", "Install Node.js 22 or newer.");

const npmMajor = version("npm", ["--version"], /^(\d+)/);
add("npm", npmMajor !== null, npmMajor ? `v${npmMajor}` : "not found", "Install npm 10 or newer.");
if (npmMajor !== null && npmMajor < 10) {
  add("npm version", false, `v${npmMajor}`, "npm 10 or newer is recommended for parity with CI.", "warning");
}

const python = process.platform === "win32"
  ? path.join(root, "backend", "venv", "Scripts", "python.exe")
  : path.join(root, "backend", "venv", "bin", "python");
const pythonCmd = existsSync(python) ? python : process.env.PYTHON || "python";
const py = run(pythonCmd, ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"]);
const pyVersion = py.ok ? py.output.trim().split(/\s+/).at(-1) : "";
const [pyMajor, pyMinor] = pyVersion.split(".").map(Number);
add("Python", py.ok, py.ok ? pyVersion : "not found", "Install Python 3.11 or newer, then run npm run startup.");
if (py.ok && !(pyMajor > 3 || (pyMajor === 3 && pyMinor >= 11))) {
  add("Python version", false, pyVersion, "Python 3.11 or newer is recommended for parity with CI.", "warning");
}

const docker = run("docker", ["compose", "version"]);
add("Docker Compose", docker.ok, docker.ok ? docker.output.split("\n")[0] : "not available", "Install Docker Desktop or use npm run startup:nodock.");

add("frontend/.env.local", existsSync(path.join(root, "frontend", ".env.local")), "frontend runtime env file", "Copy frontend/.env.example to frontend/.env.local.");
add("backend/.env", existsSync(path.join(root, "backend", ".env")), "backend runtime env file", "Copy backend/.env.example to backend/.env or run npm run startup.");

const backendEnvPath = path.join(root, "backend", ".env");
if (existsSync(backendEnvPath)) {
  const env = readFileSync(backendEnvPath, "utf8").replace(/^\uFEFF/, "");
  const debug = /^DJANGO_DEBUG=True$/m.test(env);
  const hasSecret = /^DJANGO_SECRET_KEY=.+/m.test(env);
  const hasDatabase = /^DATABASE_URL=.+/m.test(env) || /^DJANGO_DATABASE_URL=.+/m.test(env);
  const hasRedis = /^REDIS_URL=.+/m.test(env);
  add("Django secret", hasSecret, hasSecret ? "configured" : "missing", "Set DJANGO_SECRET_KEY in backend/.env.");
  add(
    "Local data backend",
    debug || (hasDatabase && hasRedis),
    debug ? "debug fallback allowed" : hasDatabase && hasRedis ? "Postgres and Redis configured" : "missing database or Redis",
    "For full-stack mode set DATABASE_URL and REDIS_URL, or use DJANGO_DEBUG=True for local SQLite/in-memory fallback.",
  );
}

const failed = checks.filter((check) => !check.ok && check.level !== "warning");
for (const check of checks) {
  const mark = check.ok ? "OK " : check.level === "warning" ? "WARN" : "ERR";
  console.log(`${mark}  ${check.name}: ${check.detail}`);
  if (!check.ok && check.fix) console.log(`     ${check.fix}`);
}

if (failed.length) {
  console.error(`\n${failed.length} check(s) failed.`);
  process.exit(1);
}

console.log("\nSkyWatch local environment looks usable.");

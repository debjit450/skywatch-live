const targets = [
  process.env.SKYWATCH_FRONTEND_URL || "http://localhost:5173",
  process.env.SKYWATCH_BACKEND_URL || "http://localhost:8000/health/live",
  process.env.SKYWATCH_API_URL || "http://localhost:8000/api/v1/flights/",
];

let failures = 0;

for (const target of targets) {
  try {
    const response = await fetch(target, { headers: { Accept: "application/json,text/html" } });
    const ok = response.status >= 200 && response.status < 500;
    console.log(`${ok ? "OK " : "ERR"}  ${target} -> HTTP ${response.status}`);
    if (!ok) failures += 1;
  } catch (error) {
    failures += 1;
    console.log(`ERR  ${target} -> ${error instanceof Error ? error.message : "unavailable"}`);
  }
}

if (failures) process.exit(1);

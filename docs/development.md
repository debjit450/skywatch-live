# Local Development Guide

SkyWatch Live supports multi-tier dev configurations depending on whether Docker Desktop is available locally.

---

## 1. Development Modes

* **Frontend-Only Mode:** `npm run dev` starts the TanStack Start and Vite server. Local routes inside `frontend/src/routes/api/` proxy requests to OpenSky Network and CelesTrak, using SGP4 in-memory propagation. No local database, Redis, or Celery instances are required.
* **Full-Stack Mode:** `npm run dev-all` launches the React frontend and Django ASGI API concurrently. Real-time ingestion requires spinning up Redis, PostgreSQL, and Celery processes.
* **Demo Simulation Mode:** Set `SKYWATCH_DEMO_MODE=True` in `backend/.env` or `VITE_SKYWATCH_DEMO_MODE=true` in `frontend/.env.local`. This serves deterministic mock flight routes, orbital satellites, and synthetic emergency squawks without making outbound network queries.

---

## 2. Bootstrapping the Environment

### Diagnostic Health Check
Before starting, execute the diagnostic script to verify system compatibility:
```powershell
npm run doctor
```
*This validates Node.js, npm, Python versions, checking for `.env` presence, and validating local SQLite fallback access.*

### Mode A: Full-Stack with Docker Infrastructure
If Docker Desktop is running locally:
```powershell
npm run startup
npm run dev-all
```
*`npm run startup` automatically provisions local environment files, spins up postgres/redis containers, configures standard Python `venv`, installs all frontend/backend dependencies, and applies Django migrations.*

### Mode B: Lightweight Standalone Fallback (No Docker)
To write code or test UI dashboards without running Docker containers:
```powershell
npm run startup:nodock
npm run dev-all
```
*This configures Django to use local SQLite databases and launches Channels/Celery task handlers using in-memory fallbacks.*

---

## 3. Background Ingestion & Celery Tasks

`npm run dev-all` starts the Vite dev server and Daphne Django server. It **does not** run background queues. To start active ingestion, open two additional shell terminals and run:

```powershell
# Terminal A: Starts the ingestion and ML scoring worker
npm run backend:celery

# Terminal B: Starts the task schedule heartbeat
npm run backend:beat
```

---

## 4. Seeding & Database Utilities

### Seed Deterministic Demo Records
To clean out local caches and seed realistic simulation flights, tracks, weather overlays, and anomaly logs:
```powershell
# Apply database migrations first
npm run backend:migrate

# Seed flight, airport, and model tables
node scripts/backend-manage.mjs seed_demo_data
```

### Complete Database Reset
To easily wipe out, rebuild the SQLite database from scratch, and instantly seed mock flight positions:
```powershell
npm run reset-local-db -- --yes
# or alias
npm run db:reset
```

---

## 5. Verification & Test Pipeline

Always run the full verification suite before committing changes to the repository:

```powershell
# 1. Runs frontend linting, typechecking, and production builds
npm run check

# 2. Runs Django system configuration check
npm run backend:check

# 3. Runs Django system check for production-hardening
npm run backend:check-deploy

# 4. Executes all backend unit tests (7/7 tests)
npm run backend:test

# 5. Executes complete check and test suite
npm test
```

### Migration Drift Diagnostics
To guarantee that modifications to `backend/flights/models.py` have matching migrations:
```powershell
cd backend
python manage.py makemigrations --check --dry-run
```


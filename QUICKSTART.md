# SkyWatch Live Quick Start

This guide provides the fastest path to boot the local development environment. For detailed operational profiles, API routes, and machine learning components, consult the main [README.md](README.md).

---

## 1. Automated Bootstrap (Windows PowerShell)

From the root directory of your cloned repository, execute the following commands in your PowerShell console:

```powershell
# 1. Run the local diagnostics to check system readiness
npm run doctor

# 2. Re-create default env files, install packages, and provision local database
npm run startup

# 3. Start React and Django API servers concurrently
npm run dev-all
```

* `npm run startup` performs automatic provisioning: it configures standard `.env` and `.env.local` templates, launches Docker Compose containers, triggers `pip` backend installation inside `backend/venv`, and executes Django migrations.

Once active, open your browser to access:
* **Frontend Dashboard:** `http://localhost:5173`
* **Django REST API:** `http://localhost:8000/api/v1/`
* **Django Administrative Panel:** `http://localhost:8000/admin/`

- Frontend dashboard: `http://localhost:5173`
- Backend REST API: `http://localhost:8000/api/v1/`
- Django admin: `http://localhost:8000/admin/`

## 2. Dockerless Fallback Mode

If Docker Desktop is not available on your workstation (or the Linux container engine daemon is blocked), you can run a lightweight, self-contained SQLite and in-memory cache/channel setup:

```powershell
# 1. Provision environment files with dockerless settings
npm run startup:nodock

# 2. Run the concurrent Vite and Django dev servers
npm run dev-all
```
*Note: Standalone fallback mode uses localizedSQLite persistence. It is suitable for rapid dashboard UI hacking but does not scale horizontally.*

## Development Commands

## 3. Background Aviation Ingestion

`npm run dev-all` starts the active API endpoints but does not process background queues. To ingest live flights, OGN gliders, weather maps, and evaluate ML anomaly scoring, open two new terminal windows and launch the background tasks:

```powershell
# Terminal A: Launches the Celery ingestion and ML worker
npm run backend:celery

# Terminal B: Launches the Celery Beat task scheduler
npm run backend:beat
```

---

## 4. Essential CLI Commands

| CLI Script Command | Purpose |
| :--- | :--- |
| `npm run doctor` | Performs diagnostic health checks on Node/npm/Python. |
| `npm run dev-all` | Runs frontend and Django concurrently. |
| `npm run reset-local-db` | Re-builds local SQLite and seeds mock flights (`npm run db:reset`). |
| `npm run check` | Runs frontend Prettier formats, TypeScript compile, and builds. |
| `npm run backend:check` | Runs Django system sanity checks. |
| `npm run backend:test` | Executes the backend Django test suite (7/7 unit tests). |
| `npm test` | Runs the end-to-end check and backend test suites together. |
| `npm run docker:up` | Boots PostgreSQL, Redis, Prometheus, Grafana, and Jaeger. |
| `npm run docker:down` | Wipes and stops local Docker containers. |

---

## 5. Local Troubleshooting

* **Upstream Rate Throttling:** If OpenSky Network public API limits are hit, register an account on the OpenSky Network portal and add your credentials (`OPENSKY_USERNAME` and `OPENSKY_PASSWORD`) to your local `backend/.env`.
* **Port Bind Conflicts:** Ensure ports `5173` (Vite) and `8000` (Django/Daphne) are not allocated by other active processes prior to running `npm run dev-all`.
* **Redis Connection Errors:** If the backend throws socket connection errors, check that Docker is running or ensure `ALLOW_IN_MEMORY_CHANNEL_LAYER=True` is enabled in `backend/.env` for standalone mode.


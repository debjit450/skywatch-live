# SkyWatch Live Quick Start

Last reviewed: 2026-05-24.

This is the fastest path to a local development environment. For the full architecture and operational details, see [README.md](README.md), [docs/development.md](docs/development.md), and [docs/architecture.md](docs/architecture.md).

## Automated Bootstrap on Windows

From the repository root in PowerShell:

```powershell
npm run doctor
npm run startup
npm run dev-all
```

`npm run startup` creates missing env files, starts Docker Compose infrastructure, installs frontend and backend dependencies, creates `backend/venv`, and runs Django migrations.

Open:

| Service | URL |
| :--- | :--- |
| Frontend dashboard | `http://localhost:8080` |
| Django REST API | `http://localhost:8000/api/v1/` |
| Django admin in local startup mode | `http://localhost:8000/admin/` |
| Prometheus | `http://localhost:9090` |
| Grafana | `http://localhost:3001` |
| Jaeger | `http://localhost:16686` |

## Dockerless Fallback

If Docker Desktop is unavailable, run SQLite and in-memory cache/channel fallbacks:

```powershell
npm run startup:nodock
npm run dev-all
```

This mode is suitable for UI and API development. It is not a production-like ingestion setup and does not scale across processes.

## Start Background Ingestion

`npm run dev-all` starts the frontend and Django API only. To ingest public feeds, persist records, run anomaly scoring, and broadcast WebSocket updates, start these in separate terminals:

```powershell
npm run backend:celery
npm run backend:beat
```

## Essential Commands

| Command | Purpose |
| :--- | :--- |
| `npm run doctor` | Checks local Node.js, npm, Python, Docker Compose, and env-file readiness. |
| `npm run dev` | Starts the frontend/TanStack Start dev server. |
| `npm run backend:dev` | Starts Django through `scripts/backend-manage.mjs`. |
| `npm run dev-all` | Starts frontend and Django concurrently. |
| `npm run backend:celery` | Starts the Celery worker. |
| `npm run backend:beat` | Starts Celery Beat. |
| `npm run reset-local-db` | Rebuilds local SQLite state and seeds mock flights. |
| `npm run check` | Runs frontend typecheck, lint, and production build. |
| `npm run backend:check` | Runs Django system checks. |
| `npm run backend:check-deploy` | Runs Django deployment checks. |
| `npm run backend:test` | Runs backend Django tests. |
| `npm test` | Runs frontend check and backend tests. |
| `npm run docker:up` | Starts PostgreSQL, PgBouncer, Redis, Jaeger, Prometheus, and Grafana. |
| `npm run docker:down` | Stops Docker Compose services. |

## Common Local Issues

- OpenSky public access can throttle. Add `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET`, or legacy `OPENSKY_USERNAME` and `OPENSKY_PASSWORD`, to improve rate limits.
- Check ports `8080` and `8000` before starting `npm run dev-all`.
- If Redis is unavailable in local development, use `npm run startup:nodock` or set `ALLOW_IN_MEMORY_CHANNEL_LAYER=True` with `DJANGO_DEBUG=True`.

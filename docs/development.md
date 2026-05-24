# Local Development Guide

Last reviewed: 2026-05-24.

SkyWatch Live supports a frontend-only workflow, a full-stack local workflow, and a deterministic demo mode. The default frontend dev port is `8080` because it is set in `frontend/vite.config.ts`.

## Development Modes

| Mode | Command | What runs |
| :--- | :--- | :--- |
| Frontend-only | `npm run dev` | TanStack Start/Vite server plus frontend server routes for OpenSky, CelesTrak, ADSBDB, photos, and flight tracks. |
| Full-stack API | `npm run dev-all` | Frontend dev server and Django dev server. This does not start Celery workers or Beat. |
| Full-stack ingestion | `npm run dev-all`, `npm run backend:celery`, `npm run backend:beat` | Frontend, Django REST/WS API, Celery worker, and Celery Beat scheduler. |
| Dockerless local fallback | `npm run startup:nodock`, then `npm run dev-all` | SQLite plus in-memory cache/channel fallback for UI and API development without Docker infrastructure. |

## Bootstrap

Run diagnostics first:

```powershell
npm run doctor
```

This checks Node.js, npm, Python, Docker Compose availability, and local env-file presence.

### Full-stack with Docker infrastructure

```powershell
npm run startup
npm run dev-all
```

`npm run startup` creates missing env files, starts the Docker Compose infrastructure stack, installs frontend and backend dependencies, creates `backend/venv`, and applies Django migrations.

### Dockerless fallback

```powershell
npm run startup:nodock
npm run dev-all
```

Dockerless mode omits `DATABASE_URL` and `REDIS_URL`, which lets Django use local SQLite and in-memory cache/channel layers while `DJANGO_DEBUG=True` and `ALLOW_IN_MEMORY_CHANNEL_LAYER=True`.

## Local URLs

| Service | URL |
| :--- | :--- |
| Frontend dashboard | `http://localhost:8080` |
| Django API | `http://localhost:8000/api/v1/` |
| Django admin in local startup mode | `http://localhost:8000/admin/` |
| Prometheus UI | `http://localhost:9090` |
| Grafana | `http://localhost:3001` |
| Jaeger | `http://localhost:16686` |

## Background Ingestion

`npm run dev-all` starts active HTTP endpoints only. To ingest public flight feeds, persist records, run anomaly scoring, and broadcast WebSocket updates, start these in separate terminals:

```powershell
npm run backend:celery
npm run backend:beat
```

Celery Beat schedules work. Celery workers execute it.

## Seeding and Database Utilities

Seed deterministic demo data:

```powershell
npm run backend:migrate
node scripts/backend-manage.mjs seed_demo_data
```

Reset the local SQLite database and seed mock records:

```powershell
npm run reset-local-db -- --yes
# or
npm run db:reset
```

## Verification

Use these commands before opening a pull request:

```powershell
npm run check
npm run backend:check
npm run backend:check-deploy
npm run backend:test
npm test
```

What they do:

| Command | Behavior |
| :--- | :--- |
| `npm run check` | Frontend typecheck, ESLint, and production build. |
| `npm run backend:check` | Django system check. |
| `npm run backend:check-deploy` | Django production deployment checks using current environment. |
| `npm run backend:test` | Django test suite. |
| `npm test` | Runs `npm run check` and `npm run backend:test`. |

Check migration drift after editing Django models:

```powershell
cd backend
python manage.py makemigrations --check --dry-run
```

## Environment Notes

- Frontend runtime env lives in `frontend/.env.local`.
- Backend runtime env lives in `backend/.env`.
- Do not commit env files, secrets, generated model artifacts, SQLite databases, `node_modules`, or `backend/venv`.
- `VITE_SKYWATCH_API_BASE` may point to either a Django root URL or a `/api/v1` URL.
- `VITE_SKYWATCH_WS_URL` can explicitly point the frontend at `/ws/flights/`; otherwise it is derived from `VITE_SKYWATCH_API_BASE`.

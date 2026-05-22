# SkyWatch Live Quick Start

Use this guide for local development. See [README.md](README.md) for the full architecture, API, configuration, and production notes.

## Automated Windows Setup

From the repository root:

```powershell
npm run startup
npm run dev-all
```

`npm run startup` creates missing local env files, starts Docker Compose unless told not to, installs frontend/backend dependencies, creates `backend/venv`, and runs Django migrations.

Open:

- Frontend dashboard: `http://localhost:5173`
- Backend REST API: `http://localhost:8000/api/v1/`
- Django admin: `http://localhost:8000/admin/`

## Without Docker

For quick local UI/API experimentation without Docker:

```powershell
npm run startup:nodock
npm run dev-all
```

This uses SQLite and in-memory cache/channel fallbacks. It is only for local development.

## Backend Ingestion

`npm run dev-all` starts the React dev server and Django API server. It does not start Celery. To run the full ingestion pipeline, open two more terminals:

```powershell
npm run backend:celery
npm run backend:beat
```

Celery Beat schedules the ingestion jobs. The Celery worker executes them.

## Development Commands

| Command | Purpose |
| :--- | :--- |
| `npm run dev` | Start the TanStack Start/Vite frontend server. |
| `npm run backend:dev` | Start only the Django API server. |
| `npm run dev-all` | Start frontend and Django API servers together. |
| `npm run backend:celery` | Start a Celery worker. |
| `npm run backend:beat` | Start Celery Beat. |
| `npm run check` | Typecheck, lint, and build the frontend. |
| `npm run backend:check-deploy` | Run Django deployment checks. |
| `npm run backend:migrate` | Apply database migrations. |

## Pre-Release Checks

```powershell
npm run check
npm run backend:check
npm run backend:check-deploy
npm run backend:test
```

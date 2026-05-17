# SkyWatch Live

SkyWatch Live is a real-time aircraft tracking and anomaly detection application. The repository is split into a TanStack Start/React frontend and a Django/Channels/Celery backend that can ingest live flight feeds, persist aircraft state, expose REST/WebSocket APIs, and run route/anomaly analysis.

## Repository Layout

```text
.
|-- .github/                  GitHub Actions CI and dependency update config
|-- backend/                  Django backend, Channels, Celery, ML helpers
|   |-- flights/              REST API, models, services, tasks, consumers
|   |-- ml/                   Training and feature extraction utilities
|   |-- skywatch/             Django settings, ASGI/WSGI, Celery, health URLs
|   `-- requirements.txt      Python dependencies
|-- frontend/                 TanStack Start React application
|   |-- src/components/       UI components
|   |-- src/hooks/            React data hooks
|   |-- src/lib/              Domain utilities and data mapping
|   |-- src/routes/           App routes and server API routes
|   `-- package.json          Frontend scripts and dependencies
|-- scripts/                  Root orchestration scripts
|-- docker-compose.yml        Local PostgreSQL and Redis services
|-- package.json              Root command shortcuts
`-- startup.ps1/startup.bat   Windows development bootstrap scripts
```

## Runtime Modes

SkyWatch can run in two modes:

- `frontend-only`: the TanStack Start app serves the dashboard and proxies OpenSky through `frontend/src/routes/api`.
- `full-stack`: Django ingests and stores flight data, Redis backs cache/WebSockets/Celery, and the frontend points at Django through `VITE_SKYWATCH_API_BASE`.

Use full-stack mode for production.

## Prerequisites

- Node.js 22+
- npm 10+
- Python 3.11+
- Docker Desktop, or equivalent PostgreSQL 16+ and Redis 7+ services

## Quick Start

On Windows, the bootstrap script creates local env files, installs dependencies, starts PostgreSQL/Redis, and applies migrations:

```powershell
npm run startup
npm run dev-all
```

Manual setup:

```bash
docker compose up -d

cd backend
python -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
cp .env.example .env
python manage.py migrate
cd ..

cd frontend
npm ci
cp .env.example .env.local
cd ..

npm run dev-all
```

Local URLs:

- Frontend: http://localhost:5173
- Backend API: http://localhost:8000/api/v1/
- Liveness: http://localhost:8000/healthz/
- Readiness: http://localhost:8000/readyz/

## Commands

Run these from the repository root unless noted.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the frontend dev server. |
| `npm run backend-dev` | Start the Django development server. |
| `npm run dev-all` | Start frontend and backend together. |
| `npm run check` | Frontend typecheck, lint, and production build. |
| `npm run backend:check` | Django system check. |
| `npm run backend:check-deploy` | Django deployment security check. |
| `npm run backend:migrate` | Apply backend migrations. |
| `npm run backend:test` | Run Django tests. |
| `npm test` | Run frontend and backend verification. |

## Environment

Never commit real `.env`, `.env.local`, credentials, tokens, database dumps, or generated secret files. The repository ignores these by default.

Backend production variables:

| Variable | Required | Notes |
| --- | --- | --- |
| `DJANGO_SECRET_KEY` | Yes | Strong unique secret. Rotate through your platform secret manager. |
| `DJANGO_DEBUG` | Yes | Must be `False` in production. |
| `ALLOWED_HOSTS` | Yes | Comma-separated backend hostnames. |
| `CSRF_TRUSTED_ORIGINS` | Yes | Comma-separated HTTPS origins. |
| `CORS_ALLOWED_ORIGINS` | Yes | Comma-separated frontend origins. |
| `DATABASE_URL` | Yes | PostgreSQL URL. SQLite is development only. |
| `REDIS_URL` | Yes | Required for production cache, Channels, and Celery. |
| `OPENSKY_CLIENT_ID` | No | Enables authenticated OpenSky access. |
| `OPENSKY_CLIENT_SECRET` | No | Store only in backend/server runtime secrets. |
| `OPENSKY_USERNAME` / `OPENSKY_PASSWORD` | No | Basic auth fallback. |

Frontend variables:

| Variable | Required | Notes |
| --- | --- | --- |
| `VITE_SKYWATCH_API_BASE` | No | Django base URL, for example `https://api.example.com`. |
| `VITE_SKYWATCH_WS_URL` | No | WebSocket URL, for example `wss://api.example.com/ws/flights/`. |
| `OPENSKY_CLIENT_ID` | No | Server route runtime only. |
| `OPENSKY_CLIENT_SECRET` | No | Server route runtime only; do not expose to browser builds. |
| `ALLOWED_AIRCRAFT_IMAGE_HOSTS` | No | Comma-separated image proxy allowlist. |
| `MAX_AIRCRAFT_IMAGE_BYTES` | No | Image proxy response byte limit. |

## Production Deployment

Recommended full-stack process layout:

- Frontend: build with `npm ci && npm run build` in `frontend/`, then run the TanStack Start production server for your chosen host.
- Django web: run ASGI with Daphne behind TLS/load balancing.
- Celery worker: run `celery -A skywatch worker --loglevel=INFO`.
- Celery beat: run `celery -A skywatch beat --loglevel=INFO`.
- PostgreSQL: use a managed database with backups and connection limits.
- Redis: use managed Redis for cache, Channels, and Celery broker/result backend.

Before promoting a release:

```bash
npm test
cd backend
python manage.py check --deploy
python manage.py makemigrations --check --dry-run
python manage.py migrate --check
python manage.py collectstatic --noinput --clear
```

Configure platform health probes:

- Liveness path: `/healthz/`
- Readiness path: `/readyz/`

## CI/CD

GitHub Actions runs on every push and pull request:

- frontend `npm ci`, typecheck, lint, production build
- backend dependency install, `check --deploy`, migration drift check, Django tests, static collection

Dependabot is configured for frontend npm packages, backend pip packages, and GitHub Actions.

For deployment, keep production deploy steps in a protected environment with required reviewers and platform-specific secrets. Do not store secrets in workflow files.

## Security Checklist

- Keep `DJANGO_DEBUG=False` in production.
- Set `DJANGO_SECRET_KEY`, `ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`, `CORS_ALLOWED_ORIGINS`, `DATABASE_URL`, and `REDIS_URL`.
- Serve only over HTTPS and enable secure cookies/HSTS when TLS is terminated correctly.
- Store OpenSky and provider credentials in the deployment secret manager.
- Keep `CORS_ALLOW_ALL_ORIGINS=False` outside local development.
- Restrict the image proxy host allowlist to trusted image domains.
- Run dependency updates through CI before merging.
- Rotate any credential that was pasted into chat, committed, logged, or shared outside your secret manager.

## Troubleshooting

- `DJANGO_SECRET_KEY is required`: copy `backend/.env.example` to `backend/.env` and set a strong key, or run `npm run startup`.
- `ALLOWED_HOSTS must be set`: set the production backend hostnames in `backend/.env`.
- `Redis is required`: set `REDIS_URL` for production, or use local Docker with `docker compose up -d`.
- Frontend cannot reach backend: set `VITE_SKYWATCH_API_BASE` and confirm backend CORS allows the frontend origin.
- WebSockets fail in production: confirm `VITE_SKYWATCH_WS_URL` uses `wss://` and that the reverse proxy supports WebSocket upgrades.

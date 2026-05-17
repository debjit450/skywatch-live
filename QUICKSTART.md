# SkyWatch Live Quick Start

## Automated Windows Setup

Run from the repository root:

```powershell
npm run startup
```

This will:

- Create `.env.local` from `.env.example`.
- Create `backend/.env` with local development values.
- Start PostgreSQL and Redis with Docker Compose.
- Install npm dependencies.
- Create `backend/venv`.
- Install backend Python dependencies.
- Run Django migrations.

Start the app:

```powershell
npm run dev-all
```

Access:

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:8000/api/v1/`
- Django admin: `http://localhost:8000/admin/`

## Without Docker

```powershell
npm run startup:nodock
npm run dev-all
```

This uses local SQLite and in-memory backend development fallbacks. Use Docker or managed PostgreSQL/Redis before production.

## Common Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Frontend only |
| `npm run backend-dev` | Backend only |
| `npm run dev-all` | Frontend and backend |
| `npm run check` | Typecheck, lint, and production build |
| `npm run backend:migrate` | Run backend migrations |
| `npm run backend:check-deploy` | Run Django deployment checks |

## Production Gate

Before deployment:

```powershell
npm run check
npm run backend:check-deploy
```

Also run migration drift checks from `backend/`:

```powershell
.\venv\Scripts\python.exe manage.py makemigrations --check --dry-run
```

Use the full [README.md](README.md) for environment variables, API routes, production deployment, and security requirements.

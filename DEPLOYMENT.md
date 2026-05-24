# Deployment Guide

Last reviewed: 2026-05-24.

This guide summarizes deployment options. The detailed hardening runbook is in [docs/production.md](docs/production.md).

## Deployment Options

| Option | Best for | Notes |
| :--- | :--- | :--- |
| Frontend-only | Public API visualization with no persistence | Uses TanStack Start server routes only. No Celery, Redis, PostgreSQL, or WebSocket fanout. |
| Single-machine full stack | Small private operations and demos | Run Daphne, Celery worker, Celery Beat, PostgreSQL, Redis, and reverse proxy on one host. |
| Containerized application | Repeatable app deployment | Backend and frontend Dockerfiles are present. Compose currently provisions infrastructure only. |
| Managed production | Reliable long-running deployment | Use managed PostgreSQL/Redis, supervised workers, TLS, backups, metrics, and retention. |

## Important Compose Note

`docker-compose.yml` currently starts infrastructure services:

- PostgreSQL
- PgBouncer
- Redis
- Jaeger
- Prometheus
- Grafana

It does not define Django or frontend application services. Run the app processes separately, or add application services before treating Compose as a complete production deployment.

## Pre-Deployment Checklist

Security:

- [ ] Generate a strong `DJANGO_SECRET_KEY` of at least 50 characters.
- [ ] Set `DJANGO_DEBUG=False`.
- [ ] Set `SKYWATCH_DEPLOYMENT_PROFILE=production`.
- [ ] Use exact `ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`, and `CORS_ALLOWED_ORIGINS`.
- [ ] Set a non-default `DJANGO_ADMIN_URL_PATH`.
- [ ] Protect `/metrics` with `METRICS_USER` and `METRICS_PASSWORD`.
- [ ] Enable TLS, secure cookies, and HSTS behind a reverse proxy.
- [ ] Keep `.env`, `.env.local`, credentials, and generated secrets out of git.

Infrastructure:

- [ ] PostgreSQL is available and backed up.
- [ ] Redis is available for cache, Channels, Celery broker, and result backend.
- [ ] Celery worker and Celery Beat are supervised separately.
- [ ] Reverse proxy supports WebSocket upgrades to `/ws/flights/`.
- [ ] Prometheus/Grafana credentials are changed from local defaults.
- [ ] Log, metrics, and retention policies are defined.

Validation:

- [ ] `python manage.py check --deploy` passes.
- [ ] `python manage.py makemigrations --check --dry-run` passes.
- [ ] Migrations are applied.
- [ ] `npm run check` passes.
- [ ] Backend tests pass.
- [ ] Health, readiness, REST, WebSocket, and metrics endpoints are verified.

## Manual Production Setup

Backend:

```bash
cd backend
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env with production values.
python manage.py migrate --noinput
python manage.py collectstatic --noinput
python manage.py check --deploy
```

Frontend:

```bash
cd frontend
npm ci
cp .env.example .env.local
# Set VITE_SKYWATCH_API_BASE and VITE_SKYWATCH_WS_URL.
npm run check
```

Run services:

```bash
cd backend
daphne -b 0.0.0.0 -p 8000 skywatch.asgi:application
```

```bash
cd backend
celery -A skywatch worker --loglevel=INFO --concurrency=4
```

```bash
cd backend
celery -A skywatch beat --loglevel=INFO --pidfile=/var/run/celerybeat.pid
```

Serve the frontend build or TanStack Start output behind your chosen Node/static hosting setup, and point it at Django with:

```env
VITE_SKYWATCH_API_BASE=https://api.example.com/api/v1
VITE_SKYWATCH_WS_URL=wss://api.example.com/ws/flights/
```

## Docker Image Builds

```bash
docker build -f backend/Dockerfile backend
docker build -f frontend/Dockerfile frontend
```

The frontend Dockerfile serves preview on port `3000`; the local Vite development server uses port `8080`.

## Essential Environment

```env
DJANGO_SECRET_KEY=replace-with-strong-random-secret-over-50-chars
DJANGO_DEBUG=False
SKYWATCH_DEPLOYMENT_PROFILE=production
ALLOWED_HOSTS=api.example.com
CSRF_TRUSTED_ORIGINS=https://api.example.com,https://example.com
CORS_ALLOWED_ORIGINS=https://example.com
DJANGO_ADMIN_URL_PATH=hidden-admin-path/

DATABASE_URL=postgres://user:password@prod-db-host:5432/skywatch
REDIS_URL=redis://default:password@prod-redis-host:6379/0
ALLOW_IN_MEMORY_CHANNEL_LAYER=False

METRICS_USER=metrics-user
METRICS_PASSWORD=strong-password

DJANGO_SECURE_SSL_REDIRECT=True
DJANGO_SECURE_HSTS_SECONDS=31536000
DJANGO_SECURE_HSTS_INCLUDE_SUBDOMAINS=True
DJANGO_SECURE_HSTS_PRELOAD=True
DJANGO_SESSION_COOKIE_SECURE=True
DJANGO_CSRF_COOKIE_SECURE=True
```

Optional integrations include OpenSky credentials, `SENTRY_DSN`, `VITE_SENTRY_DSN`, and `OTEL_EXPORTER_OTLP_ENDPOINT`.

## Scaling Notes

- Run multiple Daphne instances behind a load balancer. All instances must share the same Redis Channels layer.
- Run multiple Celery workers against the same Redis broker.
- Use PgBouncer or managed database pooling for high task concurrency.
- Use PostgreSQL read replicas for analytics-heavy workloads with `READ_REPLICA_DATABASE_URL`.
- Keep flight-state retention short unless the database is partitioned for time-series volume.

## Health and Monitoring

```bash
curl https://api.example.com/health/live
curl https://api.example.com/health/ready
curl -u "$METRICS_USER:$METRICS_PASSWORD" https://api.example.com/metrics
```

`/health/ready` checks database, cache, and Celery worker responsiveness. It can fail while app HTTP is up if no worker responds.

## Backup and Restore

PostgreSQL:

```bash
pg_dump -h prod-db-host -U skywatch skywatch > backup.sql
psql -h prod-db-host -U skywatch skywatch < backup.sql
```

Redis:

- Enable persistence if Redis state matters for your operations.
- Do not rely on Redis as the system of record; PostgreSQL is the durable store.

## Maintenance

- Run dependency audits with `npm audit --prefix frontend --audit-level=high` and `pip-audit`.
- Keep Celery workers supervised with restart limits and log retention.
- Test rollback by restoring an older image and database backup in staging.
- Run `python manage.py prune_flight_data --days 7 --batch-size 5000` or rely on the scheduled cleanup task for retention.

## Support

For deployment help, include platform, expected traffic, approximate active aircraft count, current bottleneck, relevant env redactions, and logs. See [SUPPORT.md](SUPPORT.md) and [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

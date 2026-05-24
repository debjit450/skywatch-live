# Production Runbook and Deployment Hardening

Last reviewed: 2026-05-24.

Production mode is controlled by `SKYWATCH_DEPLOYMENT_PROFILE=production` and `DJANGO_DEBUG=False`. In that profile the backend requires PostgreSQL, Redis, protected metrics, a strong secret, exact host/origin configuration, and a non-default Django admin path.

## Production Constraints

When `SKYWATCH_DEPLOYMENT_PROFILE=production` or `DJANGO_DEBUG=False` is active:

| Area | Requirement |
| :--- | :--- |
| Secret key | `DJANGO_SECRET_KEY` must be strong, unique, and at least 50 characters. |
| Hosts | `ALLOWED_HOSTS` must be exact and cannot contain `*` in production. |
| Database | `DATABASE_URL` or `DJANGO_DATABASE_URL` must be a PostgreSQL URL. SQLite fallback is blocked. |
| Redis | `REDIS_URL` must be available for cache, Channels, Celery broker, and Celery result backend. |
| In-memory channels | `ALLOW_IN_MEMORY_CHANNEL_LAYER=True` is blocked in production. |
| Admin route | `DJANGO_ADMIN_URL_PATH` must not be `admin/`. |
| Metrics | `METRICS_USER` and `METRICS_PASSWORD` are required. `/metrics` uses Basic Auth. |
| CORS | `CORS_ALLOW_ALL_ORIGINS=True` is rejected outside debug mode. |
| Transport | Secure cookie, HSTS, and TLS reverse-proxy settings should be enabled. |

## Application Processes

Run these as separate supervised processes or containers:

| Process | Command |
| :--- | :--- |
| Django ASGI app | `daphne -b 0.0.0.0 -p 8000 skywatch.asgi:application` |
| Celery worker | `celery -A skywatch worker --loglevel=INFO --concurrency=4` |
| Celery Beat | `celery -A skywatch beat --loglevel=INFO --pidfile=/var/run/celerybeat.pid` |
| Frontend build | `npm ci && npm run check` from `frontend/` |

Always place Daphne and the frontend behind a TLS-terminating reverse proxy such as Nginx, Caddy, a cloud load balancer, or a CDN edge.

## Build and Release Commands

Backend:

```bash
cd backend
python -m pip install -r requirements.txt
python manage.py migrate --noinput
python manage.py collectstatic --noinput
python manage.py check --deploy
python manage.py makemigrations --check --dry-run
python manage.py test
```

Frontend:

```bash
cd frontend
npm ci
npm run check
```

Dockerfiles exist for backend and frontend image builds:

```bash
docker build -f backend/Dockerfile backend
docker build -f frontend/Dockerfile frontend
```

The current `docker-compose.yml` is an infrastructure stack for PostgreSQL, PgBouncer, Redis, Jaeger, Prometheus, and Grafana. It does not currently define application services for the Django backend or React frontend.

## Required Environment

```env
DJANGO_SECRET_KEY=replace-with-a-strong-random-secret-over-50-chars
DJANGO_DEBUG=False
SKYWATCH_DEPLOYMENT_PROFILE=production
ALLOWED_HOSTS=api.example.com
CSRF_TRUSTED_ORIGINS=https://api.example.com,https://example.com
CORS_ALLOWED_ORIGINS=https://example.com
DJANGO_ADMIN_URL_PATH=hidden-admin-path/

DATABASE_URL=postgres://user:password@db-host:5432/skywatch
READ_REPLICA_DATABASE_URL=
REDIS_URL=redis://default:password@redis-host:6379/0
ALLOW_IN_MEMORY_CHANNEL_LAYER=False

METRICS_USER=metrics-user
METRICS_PASSWORD=strong-password

DJANGO_SECURE_SSL_REDIRECT=True
DJANGO_SECURE_HSTS_SECONDS=31536000
DJANGO_SECURE_HSTS_INCLUDE_SUBDOMAINS=True
DJANGO_SECURE_HSTS_PRELOAD=True
DJANGO_SESSION_COOKIE_SECURE=True
DJANGO_CSRF_COOKIE_SECURE=True

OPENSKY_CLIENT_ID=
OPENSKY_CLIENT_SECRET=
OPENSKY_USERNAME=
OPENSKY_PASSWORD=
SENTRY_DSN=
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
```

Frontend:

```env
VITE_SKYWATCH_API_BASE=https://api.example.com/api/v1
VITE_SKYWATCH_WS_URL=wss://api.example.com/ws/flights/
VITE_SKYWATCH_DEMO_MODE=false
VITE_SENTRY_DSN=
VITE_BUILD_SHA=
```

## Storage and Retention

SkyWatch Live can write high-volume time-series data every 15 seconds. Plan retention before running continuously.

- `cleanup-old-data-hourly` prunes `FlightState`, `FlightPosition`, `SystemMetrics`, resolved anomalies, and ingestion audits according to retention env values.
- Defaults are 7 days for flight states and positions, 14 days for system metrics, and 30 days for resolved anomalies.
- High-volume deployments should evaluate time partitioning for `FlightState` and `FlightPosition`.
- Geospatial-heavy deployments should evaluate PostGIS for geofencing and proximity queries.
- Keep database backups and test restores regularly.

Manual cleanup command:

```bash
cd backend
python manage.py prune_flight_data --days 7 --batch-size 5000
```

## Health and Observability

| Endpoint | Purpose |
| :--- | :--- |
| `/healthz/` | Lightweight liveness probe. |
| `/readyz/` | Database/cache readiness probe. |
| `/health/live` | Lightweight liveness probe for load balancers. |
| `/health/ready` | Database, cache, and Celery worker readiness. This can fail until workers are running. |
| `/health/metrics` | JSON operational metrics. |
| `/metrics` | Prometheus metrics, protected by Basic Auth when configured. |

Prometheus and Grafana provisioning lives under `monitoring/` and `grafana/provisioning/`. Update `monitoring/prometheus.yml` credentials before using it outside local development.

## Release Checklist

- [ ] `DJANGO_DEBUG=False` and `SKYWATCH_DEPLOYMENT_PROFILE=production`.
- [ ] Strong `DJANGO_SECRET_KEY`, exact `ALLOWED_HOSTS`, exact CORS/CSRF origins.
- [ ] PostgreSQL and Redis are managed or backed up.
- [ ] `DJANGO_ADMIN_URL_PATH` is non-default.
- [ ] `/metrics` requires Basic Auth.
- [ ] TLS termination and secure cookie/HSTS settings are enabled.
- [ ] `python manage.py check --deploy` passes.
- [ ] Migrations are checked and applied.
- [ ] `npm run check` and backend tests pass.
- [ ] WebSocket handshake to `/ws/flights/` works through the reverse proxy.
- [ ] Celery worker and Beat are supervised separately.
- [ ] Retention, backups, and rollback procedures are tested.

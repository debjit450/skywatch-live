# Production Runbook & Deployment Hardening

SkyWatch Live in production requires setting the environment tag `SKYWATCH_DEPLOYMENT_PROFILE=production` to enforce strict security headers, secure cookies, and optimized connection pipelines.

---

## 1. Production Profile Constraints

When `SKYWATCH_DEPLOYMENT_PROFILE=production` or `DJANGO_DEBUG=False` is set:
1. **Database:** Standard SQLite is fully blocked. A robust PostgreSQL database connection string `DATABASE_URL` is required.
2. **Cache, WS, & Task Queues:** Standard in-memory fallback layer is blocked. A fully qualified Redis cluster `REDIS_URL` is required.
3. **Security Constraints:** The server enforces SSL redirects, secure HSTS headers, secure session/CSRF cookies, and exact `CORS_ALLOWED_ORIGINS` origins.
4. **API Security:** The standard Django administrative dashboard is relocated to a custom `DJANGO_ADMIN_URL` path. Prometheus metrics at `/metrics` are secured using `METRICS_USER` and `METRICS_PASSWORD` Basic Authentication.

---

## 2. Ingestion Storage & Database Partitioning Strategy

Because SkyWatch Live persists coordinates and telemetry every 15 seconds, storage growth is rapid. In production, implement these safeguards:
1. **TimescaleDB Integration:** Convert the `FlightPosition` table into a TimescaleDB hyper-table partitioned by `timestamp` at 1-day intervals.
2. **PostGIS Support:** Standardize database installation with `django.contrib.gis.db.models` to run spatial R-Tree index calculations on geofences and proximity zones rather than computing Haversine math in Python.
3. **Data Retention Jobs:** Schedule the standard database prune task to automatically delete positions older than 7 days:
   ```bash
   python manage.py prune_flight_data --days 7 --batch-size 5000
   ```

---

## 3. Production Deployment Commands

### Step A: Build & Hardening Assets
Prepare the Python virtual environment and build static assets:
```bash
# 1. Install dependencies
python -m pip install -r requirements.txt

# 2. Run migrations
python manage.py migrate --noinput

# 3. Collect static files
python manage.py collectstatic --noinput

# 4. Perform strict security audits
python manage.py check --deploy
```

### Step B: Launch Daphne (ASGI Server)
Daphne serves HTTP and handles open WebSocket connections concurrent streams gracefully:
```bash
daphne -b 0.0.0.0 -p 8000 -v 2 skywatch.asgi:application
```
*Always deploy Daphne behind a TLS-terminating reverse proxy (Nginx, Caddy, or Cloudflare).*

### Step C: Launch Celery Workers & Beat
Run the asynchronous workers and job heartbeats as separate, isolated system daemon processes (via Systemd or Supervisord):
```bash
# Terminal A: Starts Celery worker pool
celery -A skywatch worker --loglevel=INFO --concurrency=4

# Terminal B: Starts Celery Beat Scheduler
celery -A skywatch beat --loglevel=INFO --pidfile=/var/run/celerybeat.pid
```

### Step D: Build and Serve React Frontend
Compile the client application and host static assets through Nginx:
```bash
cd frontend
npm ci
npm run check
```
Configure environment variables:
* `VITE_SKYWATCH_API_BASE`: HTTPS Django backend root URL.
* `VITE_SKYWATCH_WS_URL`: Secure WebSocket URL (`wss://.../ws/flights/`).

---

## 4. Production Release Checklist

Always execute these validations prior to releasing new build images:
- [ ] **Migrations:** All database schemas are generated, checked for drift, and applied.
- [ ] **Security Checks:** `python manage.py check --deploy` passes with zero critical failures.
- [ ] **SSL / HSTS:** SSL redirect and secure cookie flags are active.
- [ ] **Environment Overrides:** Strong `DJANGO_SECRET_KEY` and exact `ALLOWED_HOSTS` values are set.
- [ ] **Public Feeds:** Aggregator status checks show healthy circuit breaker thresholds.
- [ ] **WebSocket Broadcasts:** Liveness checks confirm Daphne handles WS handshakes.
- [ ] **Metrics Protection:** Basic Auth headers successfully block unauthorized `/metrics` reads.
- [ ] **Rollback Strategy:** Stable rollback targets and backup database snapshots are verified.


# Troubleshooting

Last reviewed: 2026-05-24.

Common issues and fixes for local development and production deployments.

## Installation and Setup

### Docker is unavailable

Symptoms: `docker: command not found`, Docker Desktop is stopped, or `docker compose` cannot reach the daemon.

Fixes:

1. Start Docker Desktop and retry `npm run docker:up`.
2. Install Docker Desktop if it is missing.
3. Use dockerless mode for UI/API development:

   ```bash
   npm run startup:nodock
   npm run dev-all
   ```

### Port already in use

Default local ports are frontend `8080` and Django `8000`.

```bash
lsof -i :8080                 # macOS/Linux
netstat -ano | findstr :8080  # Windows
npm run dev -- --port 3000    # temporary alternate frontend port
```

### Python virtual environment problems

```bash
cd backend
rm -rf venv
python -m venv venv
source venv/bin/activate      # macOS/Linux
venv\Scripts\activate         # Windows
pip install -r requirements.txt
```

### Node dependency problems

```bash
npm cache clean --force
rm -rf node_modules frontend/node_modules
npm --prefix frontend ci
```

## Database and Redis

### Database connection failed

1. Confirm infrastructure is running:

   ```bash
   docker compose ps
   ```

2. Check `DATABASE_URL` in `backend/.env`.
3. Reset local SQLite fallback when using dockerless mode:

   ```bash
   npm run db:reset -- --yes
   npm run backend:migrate
   ```

4. Check PostgreSQL logs:

   ```bash
   docker compose logs postgres
   ```

### Redis connection failed

```bash
docker compose up -d redis
redis-cli ping
docker compose logs redis
```

For local development without Redis, use `DJANGO_DEBUG=True` and `ALLOW_IN_MEMORY_CHANNEL_LAYER=True`.

### SQLite database locked

SQLite is only a local fallback. Stop extra Django/Celery processes and retry. For concurrent ingestion, use PostgreSQL.

## Frontend and Map

### Dashboard is blank

1. Open browser DevTools and check console errors.
2. Confirm the frontend is running at `http://localhost:8080`.
3. Confirm the backend if configured: `http://localhost:8000/api/v1/flights/`.
4. Check `VITE_SKYWATCH_API_BASE` and `VITE_SKYWATCH_WS_URL` in `frontend/.env.local`.

### Map does not render

The current map stack is MapLibre, react-map-gl, and deck.gl.

1. Confirm the browser supports WebGL.
2. Reload the tab after any `webglcontextlost` browser message.
3. Try a current Chromium, Firefox, or Safari build.
4. Check whether browser hardware acceleration is disabled.

### Dashboard is slow

1. Reduce visible aircraft with filters.
2. Disable optional overlays such as satellites, weather, restrictions, airports, labels, and predicted paths.
3. Check browser CPU/GPU usage.
4. Verify WebSocket and REST traffic in DevTools.
5. Test a production build:

   ```bash
   npm run build
   npm run preview
   ```

## Backend and Celery

### Background jobs are not running

`npm run dev-all` does not start Celery.

```bash
npm run backend:celery
npm run backend:beat
```

### Migrations failed

```bash
cd backend
python manage.py showmigrations
python manage.py makemigrations --check --dry-run
python manage.py migrate
```

### API returns HTTP 500

1. Check the terminal running `npm run backend:dev`.
2. Check database and Redis connectivity.
3. Confirm required env values are set.
4. Run:

   ```bash
   curl http://localhost:8000/health/ready
   npm run backend:check
   ```

## Data and Ingestion

### No aircraft on the map

1. If using frontend-only mode, OpenSky may be throttling or returning sparse public coverage.
2. If using full-stack mode, confirm Celery worker and Beat are running.
3. Check source toggles in `backend/.env`:

   ```bash
   grep ENABLED backend/.env
   ```

4. Test OpenSky from the backend shell:

   ```bash
   npm run backend:shell
   >>> from flights.services.opensky import fetch_all_states
   >>> payload = fetch_all_states()
   ```

### Data is stale

1. Restart Celery worker and Beat.
2. Clear local Redis only if you are comfortable dropping cache state:

   ```bash
   redis-cli FLUSHALL
   ```

3. Check `/health/metrics` and source health endpoints.

### Public API rate limits

OpenSky and public aggregators can throttle. Add OpenSky credentials when available:

```env
OPENSKY_CLIENT_ID=your-client-id
OPENSKY_CLIENT_SECRET=your-client-secret
```

or legacy credentials:

```env
OPENSKY_USERNAME=your-username
OPENSKY_PASSWORD=your-password
```

## WebSocket and Real-Time Updates

### No real-time updates

1. In DevTools, check the WebSocket connection to `/ws/flights/`.
2. Confirm `REDIS_URL` is reachable in full-stack mode.
3. Confirm Celery is ingesting and publishing snapshots.
4. If `VITE_SKYWATCH_API_BASE` points to a backend, ensure `VITE_SKYWATCH_WS_URL` is correct or derivable.

### WebSocket drops in production

1. Confirm the reverse proxy forwards WebSocket upgrade headers.
2. Confirm all ASGI instances share the same Redis Channels layer.
3. Check Redis health and network latency.
4. Check load balancer idle timeout settings.

## Performance

### Backend CPU is high

- Disable unused sources with `*_ENABLED=False`.
- Run fewer Celery worker processes locally.
- Use PostgreSQL instead of SQLite for ingestion.
- Profile slow endpoints before adding indexes.

### Memory is high

- Reduce retention with `FLIGHT_STATE_RETENTION_DAYS` and `FLIGHT_POSITION_RETENTION_DAYS`.
- Confirm `cleanup-old-data-hourly` is running.
- Run separate processes for ASGI, worker, and Beat.

### Slow database queries

Use PostgreSQL logs and Django query inspection. `django-extensions` is not currently installed, so `shell_plus` is not available by default.

```bash
cd backend
python manage.py shell
docker compose logs postgres
```

## Docker Infrastructure

### Container exits immediately

```bash
docker compose logs <service-name>
docker compose build --no-cache <service-name>
docker compose down
docker compose up --build
```

### Disk space is exhausted

```bash
docker system df
docker system prune -a
```

Use `docker compose down -v` only when you intend to delete local volumes.

## Production

### TLS or secure-cookie problems

1. Verify the certificate chain.
2. Confirm proxy headers reach Django.
3. Check `DJANGO_SECURE_SSL_REDIRECT`, `DJANGO_SESSION_COOKIE_SECURE`, and `DJANGO_CSRF_COOKIE_SECURE`.
4. Test with:

   ```bash
   curl -I https://your-domain.example
   ```

### Environment values are ignored

```bash
ls -la backend/.env
env | grep DJANGO
```

Remember that production supervisors, containers, and platform services often need env values configured outside local `.env` files.

## Still Stuck

Open a GitHub issue or see [SUPPORT.md](SUPPORT.md). Include exact commands, OS, Node/Python versions, Docker status, redacted env values, and logs.

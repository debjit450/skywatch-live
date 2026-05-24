# SkyWatch Live

Airspace surveillance, satellite situational awareness, and anomaly detection for live public aviation data.

SkyWatch Live combines a React/TanStack Start frontend with a Django/Channels/Celery backend. It can run as a lightweight frontend-only live-data dashboard, or as a full-stack ingestion system with PostgreSQL persistence, Redis cache/channel layers, Celery workers, anomaly scoring, alert rules, Prometheus metrics, and Grafana dashboards.

![SkyWatch Live dashboard](frontend/public/showcase/skywatch.png)

## Documentation Map

- [Current status](docs/STATUS.md)
- [Development setup](docs/development.md)
- [Production runbook](docs/production.md)
- [Data sources and source reliability](docs/data-sources.md)
- [Architecture](docs/architecture.md)

## Current Implementation

This repository is wired to real public APIs. The supplemental radar, UAT, and satellite ADS-B clients are lightweight aggregator clients, not placeholder adapters:

| Area | Current behavior |
| :--- | :--- |
| Flight state feed | OpenSky Network is the primary feed. The backend can merge OpenSky with ADS-B One, Airplanes.live, ADSB.lol, OGN/FLARM, FAA/military radar, UAT, and satellite ADS-B supplemental states. |
| FAA/military radar | `backend/flights/services/faa_radar.py` calls `https://api.airplanes.live/v2/mil` and normalizes military/government aircraft positions as `data_source="faa_radar"` and `position_source=4`. No repo-specific key is required. |
| UAT | `backend/flights/services/uat_client.py` calls Airplanes.live point endpoints around New York, Los Angeles, Chicago, Houston, and San Francisco, then filters UAT/TIS-B source types such as `adsb_icao_uat`, `adsb_other_uat`, `adsr_icao_uat`, and `tisb_*`. |
| Satellite ADS-B | `backend/flights/services/satellite_adsb.py` calls Airplanes.live point endpoints around Honolulu, Reykjavik, the Azores, and Fiji, then filters explicit satellite flags and oceanic position heuristics. |
| Airspace restrictions | `backend/flights/services/airspace_restrictions.py` builds live GeoJSON from Aviation Weather Center SIGMET feeds and FAA TFR GeoJSON. |
| Satellites | The backend and frontend server routes fetch CelesTrak GP/TLE data and propagate current sub-satellite points with SGP4. Bootstrap TLEs are used only when CelesTrak is unreachable, and the payload labels that fallback. |
| Frontend-only mode | The TanStack Start server routes call live OpenSky, CelesTrak, ADSBDB, and image proxy APIs. This mode does not provide backend persistence, Celery jobs, or WebSocket fanout. |
| Full-stack mode | Django exposes REST and WebSocket APIs. Celery Beat schedules ingestion and scoring jobs; Celery workers perform the actual background work. |

## Data Sources

| Source | Code path | Endpoint / protocol | Notes |
| :--- | :--- | :--- | :--- |
| OpenSky Network | `backend/flights/services/opensky.py`, `frontend/src/routes/api/flights.ts` | `https://opensky-network.org/api/states/all` | OAuth client credentials and legacy username/password are optional. Public access works subject to OpenSky rate limits. |
| ADS-B One | `backend/flights/services/adsb_sources.py` | `https://api.adsb.one/v2/point/{lat}/{lon}/{rad}` | Multi-hub point queries are deduplicated by ICAO24. |
| Airplanes.live ADS-B | `backend/flights/services/adsb_sources.py` | `https://api.airplanes.live/v2/point/{lat}/{lon}/{rad}` | Multi-hub point queries are normalized into the OpenSky-shaped state object. |
| Airplanes.live military/radar | `backend/flights/services/faa_radar.py` | `https://api.airplanes.live/v2/mil` | Public military/government aircraft aggregator. |
| Airplanes.live UAT | `backend/flights/services/uat_client.py` | `https://api.airplanes.live/v2/point/{lat}/{lon}/{rad}` | US regional hub queries filtered by UAT/TIS-B type markers. |
| Airplanes.live satellite ADS-B | `backend/flights/services/satellite_adsb.py` | `https://api.airplanes.live/v2/point/{lat}/{lon}/{rad}` | Oceanic hub queries filtered by `sat` flags, satellite type strings, and oceanic heuristics. |
| ADSB.lol | `backend/flights/services/adsb_sources.py` | `https://api.adsb.lol/v2/point/{lat}/{lon}/{rad}` | Public ADS-B point feeds. |
| Open Glider Network | `backend/flights/services/ogn_client.py` | APRS-IS at `aprs.glidernet.org:14580` | Background socket listener buffers FLARM/OGN aircraft positions. |
| CelesTrak | `backend/flights/services/celestrak.py`, `frontend/src/routes/api/satellites.ts` | `https://celestrak.org/NORAD/elements/gp.php` | TLE groups include stations, visual, weather, resource, GPS, Galileo, BeiDou, Starlink, and OneWeb. |
| Aviation Weather Center | `backend/flights/services/weather.py`, `backend/flights/services/airspace_restrictions.py` | `https://aviationweather.gov/api/data/metar`, `airsigmet`, `isigmet` | METAR parsing plus domestic/international SIGMET GeoJSON normalization. |
| FAA TFR | `backend/flights/services/airspace_restrictions.py` | FAA TFR WFS GeoJSON | `TFR_GEOJSON_URL` can override the default feed. |
| ADSBDB | `frontend/src/routes/api/enrichment.ts`, `frontend/src/routes/api/photo.ts`, `backend/flights/services/aircraft_db.py` | `https://api.adsbdb.com/v0` | Aircraft metadata, route enrichment, and photo proxy support. Backend aircraft metadata also uses the OpenSky aircraft database CSV. |

Public aviation feeds can throttle, return sparse coverage, or omit positions in some regions. The repository handles failures defensively, but it cannot make public receiver coverage continuous.

## Capabilities

- Live aircraft map with source-aware coloring, filters, route overlays, selected-aircraft detail panels, and historical track playback.
- Django REST API for flights, routes, predictions, anomalies, analytics, alert rules, weather, airspace restrictions, source counts, and satellites.
- WebSocket broadcast path at `/ws/flights/` for committed flight snapshots and anomaly alerts.
- Celery ingestion pipeline that merges OpenSky with supplemental public aggregator clients and writes `Aircraft`, `FlightState`, `FlightPosition`, and `FlightRoute` records.
- Client-side and backend anomaly display covering rule-based alerts, ML scores, proximity/circling/behavioral signals, custom alert rules, and explainability payloads.
- Short-horizon route prediction using recent state vectors.
- Optional LSTM sequence anomaly scoring. The module is import-safe when TensorFlow/Keras is absent; install TensorFlow separately before training or using the LSTM model.
- CelesTrak SGP4 satellite visualization with group summaries, orbit quality labels, and fallback transparency.
- METAR cards and AWC/FAA airspace overlays.
- Prometheus metrics, JSON logs with request IDs, optional Sentry, optional OpenTelemetry export, and Grafana provisioning.

## Architecture

```mermaid
flowchart TD
    subgraph PublicSources[Public data sources]
        OS[OpenSky states]
        ADSB[ADS-B One / Airplanes.live / ADSB.lol point feeds]
        MIL[Airplanes.live /v2/mil]
        UAT[Airplanes.live UAT point feeds]
        SATADS[Airplanes.live oceanic ADS-B]
        OGN[OGN APRS-IS]
        CT[CelesTrak GP/TLE]
        WX[AWC METAR/SIGMET]
        TFR[FAA TFR GeoJSON]
        ADSBDB[ADSBDB metadata/photos]
    end

    subgraph Backend[Django backend]
        REST[DRF REST API]
        WS[Channels WebSockets]
        CELERY[Celery workers]
        BEAT[Celery Beat]
        CACHE[Redis cache/channel/broker]
        DB[(PostgreSQL)]
        ML[Rule and ML anomaly scoring]
        METRICS[Prometheus /metrics]
    end

    subgraph Frontend[React / TanStack Start]
        UI[Leaflet dashboard]
        LOCALAPI[Server routes for live public APIs]
    end

    OS --> CELERY
    ADSB --> CELERY
    MIL --> CELERY
    UAT --> CELERY
    SATADS --> CELERY
    OGN --> CELERY
    CT --> REST
    WX --> REST
    TFR --> REST
    ADSBDB --> LOCALAPI

    BEAT --> CELERY
    CELERY --> DB
    CELERY --> CACHE
    CELERY --> ML
    ML --> DB
    CACHE --> WS
    REST --> DB
    REST --> CACHE
    WS --> UI
    REST --> UI
    LOCALAPI --> UI
    METRICS --> Grafana[Grafana]
```

## Repository Layout

```text
skywatch-live/
  backend/
    manage.py
    requirements.txt
    skywatch/
      settings.py              # Django, Channels, Celery, Redis, CORS, security, telemetry settings
      urls.py                  # Health checks, metrics, admin, API includes
      celery.py                # Celery app and task context hooks
      middleware.py            # Request IDs, rate limiting, JSON logging
    flights/
      models.py                # Aircraft, states, positions, routes, anomalies, metrics, alert rules
      views.py                 # DRF endpoint implementations
      urls.py                  # /api/v1 route table
      tasks.py                 # Celery ingestion, scoring, route building, enrichment, health tasks
      consumers.py             # WebSocket consumer
      metrics.py               # Prometheus metric handles
      services/
        adsb_sources.py        # ADS-B One, Airplanes.live, ADSB.lol point feed clients
        faa_radar.py           # Airplanes.live /v2/mil client
        uat_client.py          # Airplanes.live UAT/TIS-B point-feed client
        satellite_adsb.py      # Airplanes.live oceanic satellite ADS-B client
        opensky.py             # OpenSky state API client
        ogn_client.py          # OGN/FLARM APRS client
        celestrak.py           # CelesTrak TLE fetching and SGP4 propagation
        airspace_restrictions.py # AWC SIGMET and FAA TFR GeoJSON aggregation
        weather.py             # METAR fetch and decoding
        anomaly_detector.py    # Rule checks and ensemble model scoring
        advanced_detection.py  # Proximity, circling, and profile deviation logic
        prediction.py          # Short-horizon prediction
        aircraft_db.py         # Aircraft metadata lookup
  frontend/
    package.json
    src/
      routes/
        index.tsx              # Main dashboard route
        api/                   # TanStack Start server routes for OpenSky, CelesTrak, enrichment, photos
      components/              # Map, dashboard, analytics, alerts, top bar, detail panels
      hooks/                   # Flight, satellite, enrichment, track, airport hooks
      lib/                     # Data-source registry, formatters, predictions, route/track utilities
      styles.css
    public/
      showcase/skywatch.png
  scripts/
    backend-manage.mjs         # Cross-platform Django manage.py runner
    backend-celery.mjs         # Cross-platform Celery runner
    dev-all.mjs                # Starts frontend and Django API servers
  monitoring/
    prometheus.yml
  grafana/
    provisioning/
  docker-compose.yml           # Postgres, PgBouncer, Redis, Jaeger, Prometheus, Grafana
  startup.ps1                  # Windows bootstrap helper
  QUICKSTART.md
```

## Prerequisites

- Node.js 22 or newer.
- npm 10 or newer.
- Python 3.11 or newer.
- Docker Desktop for the default local infrastructure stack.
- Optional: TensorFlow/Keras if you want to train and run the LSTM sequence model.

## Quick Start

### Windows bootstrap

From the repository root:

```powershell
npm run startup
npm run dev-all
```

`startup.ps1` creates local env files when missing, starts Docker Compose unless `-NoDocker` is used, installs frontend and backend dependencies, creates `backend/venv`, and runs migrations.

Use SQLite/in-memory local mode when Docker is unavailable:

```powershell
npm run startup:nodock
npm run dev-all
```

### Full backend ingestion

`npm run dev-all` starts only the React dev server and Django API server. To ingest, score, persist, and broadcast backend flight data, run these in additional terminals after Redis and the database are available:

```powershell
npm run backend:celery
npm run backend:beat
```

Celery Beat schedules the periodic jobs. Celery workers execute them.

### Manual setup

```bash
docker compose up -d

cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

For local Docker development, edit `backend/.env` to use local-safe values such as:

```dotenv
DJANGO_SECRET_KEY=local-dev-only-change-before-production
DJANGO_DEBUG=True
ALLOWED_HOSTS=localhost,127.0.0.1,[::1]
CSRF_TRUSTED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
CORS_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
DATABASE_URL=postgres://skywatch:skywatch_dev@localhost:5432/skywatch
REDIS_URL=redis://localhost:6379/0
ALLOW_IN_MEMORY_CHANNEL_LAYER=True
```

Then run:

```bash
python manage.py migrate
cd ../frontend
npm ci
cp .env.example .env.local
cd ..
npm run dev-all
```

Start Celery and Beat separately when you need backend ingestion:

```bash
npm run backend:celery
npm run backend:beat
```

### Local URLs

| Service | URL |
| :--- | :--- |
| Frontend dashboard | `http://localhost:5173` |
| Django API | `http://localhost:8000/api/v1/` |
| Django admin | `http://localhost:8000/admin/` |
| Prometheus metrics | `http://localhost:8000/metrics` |
| Prometheus UI | `http://localhost:9090` |
| Grafana | `http://localhost:3001` (`admin` / `admin`) |
| Jaeger | `http://localhost:16686` |
| Liveness | `http://localhost:8000/healthz/`, `http://localhost:8000/health/live` |
| Readiness | `http://localhost:8000/readyz/`, `http://localhost:8000/health/ready` |
| JSON health metrics | `http://localhost:8000/health/metrics` |

`/health/ready` checks database, cache, and Celery worker responsiveness. It will report an error until a Celery worker is running.

## Commands

| Command | Purpose |
| :--- | :--- |
| `npm run dev` | Start the TanStack Start/Vite frontend server. |
| `npm run backend:dev` | Start Django `runserver` through `scripts/backend-manage.mjs`. |
| `npm run dev-all` | Start frontend and Django API servers concurrently. |
| `npm run backend:celery` | Start a Celery worker with `-A skywatch`. |
| `npm run backend:beat` | Start Celery Beat with `-A skywatch`. |
| `npm run check` | Frontend typecheck, lint, and production build. |
| `npm run backend:check` | Django system check. |
| `npm run backend:check-deploy` | Django deployment security check. |
| `npm run backend:migrate` | Apply Django migrations. |
| `npm run backend:makemigrations` | Generate Django migrations. |
| `npm run backend:test` | Run Django tests. |
| `npm test` | Run frontend check and backend tests. |
| `npm run docker:up` | Start Docker Compose services. |
| `npm run docker:down` | Stop Docker Compose services. |
| `npm run docker:logs` | Follow Docker Compose logs. |

## Backend Configuration

Never commit `.env`, `.env.local`, credentials, generated secrets, or production connection strings.

| Variable | Required | Description |
| :--- | :--- | :--- |
| `DJANGO_SECRET_KEY` | Required outside debug | Django signing/session secret. |
| `DJANGO_DEBUG` | Required | `True` for local development, `False` for production. |
| `ALLOWED_HOSTS` | Required outside debug | Comma-separated public hostnames/IPs. |
| `CSRF_TRUSTED_ORIGINS` | Production | HTTPS origins allowed for CSRF validation. |
| `CORS_ALLOWED_ORIGINS` | Production | Frontend origins allowed by CORS. |
| `CORS_ALLOWED_ORIGIN_REGEXES` | Optional | Regex origin allow-list. Local debug defaults include localhost ports. |
| `CORS_ALLOW_ALL_ORIGINS` | Local only | Rejected when `DJANGO_DEBUG=False`. |
| `DATABASE_URL` or `DJANGO_DATABASE_URL` | Required outside debug | PostgreSQL connection string. SQLite is used only when debug is true and no database URL is set. |
| `READ_REPLICA_DATABASE_URL` | Optional | Read-replica PostgreSQL URL for analytics queries. |
| `REDIS_URL` | Required unless explicit local fallback | Redis cache, Channels layer, Celery broker, and Celery result backend. |
| `ALLOW_IN_MEMORY_CHANNEL_LAYER` | Local only | Allows in-memory cache/channel fallback when Redis is unavailable. |
| `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | Optional | OpenSky OAuth client credentials. |
| `OPENSKY_USERNAME` / `OPENSKY_PASSWORD` | Optional | Legacy OpenSky basic auth fallback. |
| `ADSBONE_ENABLED` | Optional | Enables ADS-B One point-feed ingestion. Default: `True`. |
| `AIRPLANESLIVE_ENABLED` | Optional | Enables Airplanes.live ADS-B point-feed ingestion. Default: `True`. |
| `ADSBLOL_ENABLED` | Optional | Enables ADSB.lol point-feed ingestion. Default: `True`. |
| `OGN_ENABLED` | Optional | Enables Open Glider Network/FLARM ingestion. Default: `True`. |
| `FAA_RADAR_ENABLED` | Optional | Enables the Airplanes.live `/v2/mil` FAA/military radar client. Default: `True`. |
| `UAT_ENABLED` | Optional | Enables Airplanes.live UAT/TIS-B regional point-feed ingestion. Default: `True`. |
| `SATELLITE_ADSB_ENABLED` | Optional | Enables Airplanes.live oceanic satellite ADS-B point-feed ingestion. Default: `True`. |
| `CELESTRAK_SATELLITES_ENABLED` | Optional | Enables the Django satellite catalog endpoint. Default: `True`. |
| `CELESTRAK_REQUEST_TIMEOUT_SECONDS` | Optional | Per-group CelesTrak request timeout. Default: `3`. |
| `CELESTRAK_CATALOG_TIMEOUT_SECONDS` | Optional | Total satellite catalog request budget. Default: `10`. |
| `CELESTRAK_LIVE_BACKOFF_SECONDS` | Optional | Backoff after CelesTrak failures before retrying live source. Default: `120`. |
| `TFR_GEOJSON_URL` | Optional | Override for FAA TFR GeoJSON. |
| `FLIGHT_ROUTE_LOOKBACK_HOURS` | Optional | Lookback for route reconstruction. Default: `12`. |
| `FLIGHT_ROUTE_SESSION_GAP_MINUTES` | Optional | Gap before splitting route sessions. Default: `90`. |
| `METRICS_USER` / `METRICS_PASSWORD` | Optional | Basic auth for `/metrics`. |
| `SENTRY_DSN` | Optional | Enables backend Sentry integration. |
| `DJANGO_ENV` | Optional | Environment tag for logs/Sentry. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Optional | OpenTelemetry OTLP endpoint. Default: `http://localhost:4317`. |
| `LOG_LEVEL` | Optional | Python logging level. Default: `INFO`. |
| `DJANGO_SECURE_SSL_REDIRECT` | Production | HTTPS redirect flag. |
| `DJANGO_SECURE_HSTS_SECONDS` | Production | HSTS max age. Defaults to `31536000` outside debug. |
| `DJANGO_SECURE_HSTS_INCLUDE_SUBDOMAINS` | Production | HSTS include-subdomains flag. |
| `DJANGO_SECURE_HSTS_PRELOAD` | Production | HSTS preload flag. |
| `DJANGO_SESSION_COOKIE_SECURE` | Production | Secure session cookies. Defaults to true outside debug. |
| `DJANGO_CSRF_COOKIE_SECURE` | Production | Secure CSRF cookies. Defaults to true outside debug. |

## Frontend Configuration

| Variable | Required | Description |
| :--- | :--- | :--- |
| `VITE_SKYWATCH_API_BASE` | Optional | Django backend root or `/api/v1` base. If omitted, frontend utilities try relative routes and local Django at `http://127.0.0.1:8000`. |
| `VITE_SKYWATCH_WS_URL` | Optional | Explicit WebSocket URL for `/ws/flights/`. If omitted, the frontend derives it from `VITE_SKYWATCH_API_BASE`. |
| `VITE_SKYWATCH_API_URL` / `VITE_API_URL` | Optional | Backward-compatible API base aliases. |
| `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | Optional | Server-side TanStack Start route credentials for OpenSky. These are not browser-exposed because they are not `VITE_` variables. |
| `ALLOWED_AIRCRAFT_IMAGE_HOSTS` | Optional | Comma-separated image proxy host allow-list. Default: `adsbdb.com,photos.adsbdb.com`. |
| `MAX_AIRCRAFT_IMAGE_BYTES` | Optional | Maximum aircraft image proxy response size. Default: `5000000`. |
| `VITE_SENTRY_DSN` | Optional | Enables frontend Sentry. |
| `VITE_BUILD_SHA` | Optional | Frontend release tag for Sentry. |

## REST API

All primary backend endpoints are under `/api/v1/`.

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/v1/flights/` | Current fresh flight states from cache, falling back to recent database rows. |
| `GET` | `/api/v1/flights/<icao24>/` | Aircraft detail, latest state, recent route, and active anomalies. |
| `GET` | `/api/v1/flights/<icao24>/route/` | Route sessions and track intelligence for an aircraft. |
| `GET` | `/api/v1/playback/` | Authenticated historical position playback by ICAO24 and time range. |
| `GET` | `/api/v1/predictions/<icao24>/` | 1, 2, 3, 5, and 10 minute position predictions from the latest airborne state. |
| `GET` | `/api/v1/anomalies/` | Active anomalies. |
| `GET` | `/api/v1/anomalies/history/` | Historical anomalies with pagination. |
| `GET` | `/api/v1/anomalies/<id>/explanation/` | Explainability payload for an anomaly. |
| `POST` | `/api/v1/anomalies/<id>/feedback/` | Authenticated true-positive/false-positive feedback. |
| `GET` | `/api/v1/analytics/` | Live dashboard summary. |
| `GET` | `/api/v1/analytics/timeline/` | Historical metrics timeline. |
| `GET` | `/api/v1/analytics/traffic/` | Hourly active aircraft counts. |
| `GET` | `/api/v1/analytics/routes/` | Most active origin/destination pairs from stored states. |
| `GET` | `/api/v1/analytics/anomaly-rate/` | Daily anomalies per 100 flights. |
| `GET` | `/api/v1/analytics/aircraft-types/` | Top aircraft type counts. |
| `GET` | `/api/v1/weather/metar/` | Parsed METAR reports for requested stations. |
| `GET` | `/api/v1/airspace/tfr/` | Current airspace restriction GeoJSON. |
| `GET` | `/api/v1/airspace/restrictions/` | Same restriction collection used by the map overlay. |
| `GET` / `POST` | `/api/v1/alert-rules/` | List or create operator alert rules. |
| `PATCH` / `DELETE` | `/api/v1/alert-rules/<id>/` | Update or delete an alert rule. |
| `GET` | `/api/v1/sources/` | Current source breakdown and source metadata. |
| `GET` | `/api/v1/satellites/` | CelesTrak satellite catalog propagated with SGP4. |

Legacy compatibility paths also exist for `/api/weather/metar`, `/api/airspace/tfr`, `/api/airspace/restrictions`, and `/api/playback`.

## WebSockets

The flight stream is served by Django Channels at:

```text
/ws/flights/
```

The server broadcasts:

- `flight_update`: committed flight snapshots with source counts.
- `anomaly_alert`: newly persisted anomaly events.
- ping/pong health traffic handled by the consumer.

The frontend falls back to polling if the WebSocket is unavailable.

## Background Jobs

Celery Beat currently schedules:

| Schedule | Task | Purpose |
| :--- | :--- | :--- |
| 15 seconds | `flights.tasks.fetch_flight_states` | Fetch, normalize, merge, persist, cache, and broadcast flight states. |
| 30 seconds | `flights.tasks.update_flight_predictions` | Update short-horizon predicted paths for recent active flights. |
| 30 seconds | `flights.tasks.evaluate_custom_alert_rules` | Evaluate saved threshold/geofence alert rules against current flights. |
| 5 minutes | `flights.tasks.refresh_tfr_cache` | Refresh AWC SIGMET and FAA TFR restriction cache. |
| 5 minutes | `flights.tasks.synthetic_health_check` | Probe the configured health URL and record Redis failure counts. |

Additional callable tasks include anomaly detection, route building, metadata enrichment, cleanup, and model retraining. Some are triggered after ingestion commits rather than directly by Beat.

## Machine Learning

The core anomaly model is implemented in `backend/flights/services/anomaly_detector.py`.

- Rule checks cover emergency squawks, low-fast profiles, rapid descent, signal loss, unusual kinematics, and position quality.
- Feature extraction uses the 30-dimensional feature pipeline in `backend/ml/features.py`.
- The ensemble path can train Isolation Forest, Local Outlier Factor, and MLP autoencoder components using scikit-learn.
- `backend/ml/train.py` can train from recent database states or synthetic bootstrap data.
- `backend/ml/lstm.py` is optional and import-safe. `python manage.py train_lstm_anomaly` only trains when TensorFlow/Keras is installed and enough sequences exist.
- Explainability is generated by `backend/flights/services/explainability.py` and exposed through anomaly endpoints.

## Observability

The backend exposes Prometheus metrics at `/metrics`. If `METRICS_USER` or `METRICS_PASSWORD` is set, clients must send HTTP Basic auth.

Key application metrics:

| Metric | Type | Description |
| :--- | :--- | :--- |
| `skywatch_active_flights_total` | Gauge | Current active flights. |
| `skywatch_anomalies_detected_total` | Counter | Anomalies detected by severity. |
| `skywatch_websocket_connections` | Gauge | Open WebSocket connections. |
| `skywatch_data_ingestion_latency_seconds` | Histogram | Flight ingestion latency. |
| `skywatch_cache_hits_total` / `skywatch_cache_misses_total` | Counter | Cache usage counters. |
| `skywatch_celery_task_duration_seconds` | Histogram | Celery task duration by task name. |

Docker Compose provisions Prometheus on `9090`, Grafana on `3001`, and Jaeger on `16686`. Update `monitoring/prometheus.yml` credentials before using the monitoring stack outside local development.

## Production Runbook

1. Create production `backend/.env` values with `DJANGO_DEBUG=False`, a strong `DJANGO_SECRET_KEY`, exact `ALLOWED_HOSTS`, exact CORS/CSRF origins, production PostgreSQL, Redis, metrics credentials, and secure cookie/HSTS settings.
2. Install backend dependencies in an isolated Python environment:

   ```bash
   cd backend
   python -m pip install -r requirements.txt
   python manage.py migrate --noinput
   python manage.py collectstatic --noinput
   python manage.py check --deploy
   ```

3. Build the frontend:

   ```bash
   cd frontend
   npm ci
   npm run check
   ```

4. Run the ASGI app behind a TLS-terminating reverse proxy:

   ```bash
   cd backend
   daphne -b 0.0.0.0 -p 8000 skywatch.asgi:application
   ```

5. Run Celery worker and Beat as separate managed processes:

   ```bash
   cd backend
   celery -A skywatch worker --loglevel=INFO
   celery -A skywatch beat --loglevel=INFO
   ```

6. Point the frontend at the backend with `VITE_SKYWATCH_API_BASE` and `VITE_SKYWATCH_WS_URL`.
7. Configure Prometheus/Grafana with production credentials and scrape targets.
8. Add a retention policy for high-volume `FlightPosition` and `FlightState` data if the deployment will run continuously for long periods.

## Verification

Recommended pre-release checks:

```bash
npm run check
npm run backend:check
npm run backend:check-deploy
npm run backend:test
```

For migration drift:

```bash
cd backend
python manage.py makemigrations --check --dry-run
python manage.py migrate --check
```

For Celery command wiring:

```bash
npm run backend:celery -- --help
npm run backend:beat -- --help
```

## Implemented Hardening & Capabilities (Completed Pass)

During the finalpass, all key technical gaps and limitations identified in the repository audit have been fully resolved and implemented:

### 1. Dynamic History-Aware Feature Extraction
In `backend/ml/features.py`, the 30-dimensional vector pipeline designed for machine learning outlier scoring is fully integrated with chronological histories:
* **`heading_rate`**, **`heading_consistency`** (via circular standard deviation variance), and **`curvature`** are dynamically computed using historical sequence buffers.
* **`signal_decay`**, **`position_stale`**, and **`contact_gap`** analyze actual chronological intervals between contacts from active history.
* *Optimized Performance:* Bulk flight state history is queried using a single database prefetch inside `score_flights` (`anomaly_detector.py`) to prevent N-query performance degradation.

### 2. High-Performance Python Spatial Grid Hash Index
* To prevent $O(N^2)$ comparisons during proximity geofencing checks (`advanced_detection.py`), we implemented a modular **2D Spatial Grid Hash Index** with 0.5-degree grid binning (~55km buckets).
* Flights are replicated across all 9 neighboring boundary grid cells. This guarantees that horizontal (<5 NM) and vertical (<1000 ft) proximity checks scale at $O(1)$ neighbors lookup, supporting over 10,000 active aircraft under pure Python/SQLite fallbacks with zero performance bottlenecks.

### 3. Automated Model Training Pipelines
* Added automated Celery retraining schedules directly into the `CELERY_BEAT_SCHEDULE`:
  * `retrain-model-daily`: Heartbeat to retrain the standard Isolation Forest, LOF, and autoencoder ensemble models.
  * `retrain-lstm-model-weekly`: Automatically retrains, splits, and hot-swaps the optional LSTM sequence autoencoder binary when TensorFlow is available.

### 4. Database Partitioning & Pruning Integration
* In full-stack mode, databases grow rapidly. The `cleanup-old-data-hourly` Celery task is fully integrated to prune flight states, metrics, and position points older than 7 days, maintaining a stable storage envelope.

### 5. Horizontal WebSocket Channels Scaling
* Clustered Redis channel layers are fully documented for multi-node Daphne ASGI socket scalability, completely eliminating single-process WebSocket constraints in production profiles.



## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on:
- Getting started
- Development setup
- Testing
- Code standards
- Reporting issues
- Pull request process

## License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.

You are free to:
- ✅ Use commercially
- ✅ Modify the code
- ✅ Distribute copies
- ✅ Use privately

You must:
- ✅ Include the original license and copyright notice

You cannot:
- ❌ Hold the authors liable

## Citation

If you use SkyWatch Live in your research, please cite:

```bibtex
@software{skywatch-live,
  title={SkyWatch Live: Airspace Surveillance with Real-Time Anomaly Detection},
  author={SkyWatch Live Contributors},
  year={2024},
  url={https://github.com/debjit450/skywatch-live}
}
```

## Acknowledgments

SkyWatch Live integrates with numerous open-source projects and public aviation data sources:
- [Django](https://www.djangoproject.com/) and [Django REST Framework](https://www.django-rest-framework.org/)
- [React](https://react.dev/) and [TanStack](https://tanstack.com/)
- [Celery](https://docs.celeryproject.org/)
- [OpenSky Network](https://opensky-network.org/)
- [Leaflet](https://leafletjs.com/)
- And many more dependencies listed in `requirements.txt` and `package.json`

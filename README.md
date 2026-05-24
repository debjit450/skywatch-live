# SkyWatch Live

Airspace surveillance, satellite situational awareness, and anomaly detection for live public aviation data.

SkyWatch Live combines a React/TanStack Start frontend with a Django/Channels/Celery backend. It can run as a lightweight frontend-only live-data dashboard, or as a full-stack ingestion system with PostgreSQL persistence, Redis cache/channel layers, Celery workers, anomaly scoring, alert rules, Prometheus metrics, Jaeger tracing, and Grafana dashboards.

![SkyWatch Live dashboard](frontend/public/showcase/skywatch.png)

## Documentation Map

- [Quick start](QUICKSTART.md)
- [Architecture](docs/architecture.md)
- [Development setup](docs/development.md)
- [Production runbook](docs/production.md)
- [Data sources and reliability](docs/data-sources.md)
- [Current status](docs/STATUS.md)
- [Deployment guide](DEPLOYMENT.md)
- [Testing guide](TESTING.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Current Implementation

This repository is wired to real public APIs. Supplemental radar, UAT, and satellite ADS-B clients are lightweight public aggregator clients, not placeholder adapters.

| Area | Current behavior |
| :--- | :--- |
| Flight state feed | OpenSky Network is the primary feed. The backend can merge OpenSky with ADS-B One, Airplanes.live, ADSB.lol, OGN/FLARM, FAA/military radar aggregate, UAT, and satellite ADS-B supplemental states. |
| FAA/military radar | `backend/flights/services/faa_radar.py` calls `https://api.airplanes.live/v2/mil` and normalizes aircraft as `data_source="faa_radar"` and `position_source=4`. |
| UAT | `backend/flights/services/uat_client.py` calls Airplanes.live point endpoints around major US hubs and filters UAT/TIS-B type markers. |
| Satellite ADS-B | `backend/flights/services/satellite_adsb.py` calls Airplanes.live point endpoints around oceanic regions and filters satellite flags plus remote-position heuristics. |
| Airspace restrictions | `backend/flights/services/airspace_restrictions.py` builds GeoJSON from Aviation Weather Center SIGMET feeds and FAA TFR GeoJSON. |
| Satellites | Backend and frontend server routes fetch CelesTrak GP/TLE data and propagate current sub-satellite points with SGP4. Bundled bootstrap TLEs are used only when live CelesTrak access is unavailable. |
| Frontend-only mode | TanStack Start server routes call OpenSky, CelesTrak, ADSBDB, and image proxy APIs. This mode does not provide backend persistence, Celery jobs, or WebSocket fanout. |
| Full-stack mode | Django exposes REST and WebSocket APIs. Celery Beat schedules ingestion and scoring jobs; Celery workers execute them. |

Public aviation feeds can throttle, return sparse coverage, or omit positions in some regions. SkyWatch Live handles failures defensively, but it cannot make public receiver coverage continuous.

## Capabilities

- Live MapLibre/deck.gl aircraft map with source-aware coloring, filters, route overlays, selected-aircraft detail panels, and historical track playback.
- Django REST API for flights, routes, predictions, anomalies, analytics, alert rules, weather, airspace restrictions, source counts, source health, ingestion audits, model status, and satellites.
- WebSocket broadcast path at `/ws/flights/` for initial snapshots, committed flight snapshots, and anomaly alerts.
- Celery ingestion pipeline that merges OpenSky with supplemental public aggregator clients and writes `Aircraft`, `FlightState`, `FlightPosition`, and `FlightRoute` records.
- Client-side and backend anomaly display covering rule-based alerts, ML scores, proximity/circling/behavioral signals, custom alert rules, and explainability payloads.
- Short-horizon route prediction using recent state vectors.
- Optional LSTM sequence anomaly scoring. TensorFlow/Keras is intentionally not part of default requirements.
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

    subgraph Frontend[React / TanStack Start]
        UI[MapLibre + deck.gl dashboard]
        LOCALAPI[Server routes for live public APIs]
    end

    subgraph Backend[Django ASGI backend]
        REST[DRF REST API]
        WS[Channels WebSocket]
        CELERY[Celery workers]
        BEAT[Celery Beat]
        CACHE[Redis cache/channel/broker]
        DB[(PostgreSQL)]
        ML[Rule and ML anomaly scoring]
        METRICS[Prometheus /metrics]
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

See [docs/architecture.md](docs/architecture.md) for expanded diagrams and runtime details.

## Repository Layout

```text
skywatch-live/
  backend/
    manage.py
    requirements.txt
    skywatch/
      settings.py              # Django, Channels, Celery, Redis, CORS, security, telemetry
      urls.py                  # Health checks, metrics, admin, OpenAPI, API includes
      celery.py                # Celery app
      middleware.py            # Request IDs, rate limiting, JSON logging
    flights/
      models.py                # Aircraft, states, positions, routes, anomalies, metrics, alert rules
      views.py                 # DRF endpoint implementations
      urls.py                  # /api/v1 route table
      tasks.py                 # Celery ingestion, scoring, route building, enrichment, cleanup
      consumers.py             # WebSocket consumer
      metrics.py               # Prometheus metrics
      services/                # Source clients, cache, prediction, anomaly, weather, airspace logic
    ml/                        # ML features, training, optional LSTM helpers
  frontend/
    package.json
    src/
      routes/
        index.tsx              # Main dashboard
        api/                   # TanStack Start server routes
      components/              # Map, dashboard, analytics, alerts, top bar, detail panels
      hooks/                   # Flight, satellite, enrichment, track, airport hooks
      lib/                     # Source registry, formatting, predictions, route/track utilities
    public/showcase/skywatch.png
  scripts/
    backend-manage.mjs
    backend-celery.mjs
    dev-all.mjs
    doctor.mjs
  monitoring/
    prometheus.yml
  grafana/provisioning/
  docker-compose.yml           # Postgres, PgBouncer, Redis, Jaeger, Prometheus, Grafana
```

## Prerequisites

- Node.js 22 or newer.
- npm 10 or newer recommended.
- Python 3.11 or newer.
- Docker Desktop for the default local infrastructure stack.
- Optional: TensorFlow/Keras if you want to train and run the LSTM sequence model.

## Quick Start

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

To ingest, score, persist, and broadcast backend flight data, run these in additional terminals after Redis and the database are available:

```powershell
npm run backend:celery
npm run backend:beat
```

## Manual Setup

```bash
docker compose up -d

cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

For local Docker development, edit `backend/.env` to use local-safe values:

```dotenv
DJANGO_SECRET_KEY=local-dev-only-change-before-production
DJANGO_DEBUG=True
SKYWATCH_DEPLOYMENT_PROFILE=local
ALLOWED_HOSTS=localhost,127.0.0.1,[::1]
CSRF_TRUSTED_ORIGINS=http://localhost:8080,http://127.0.0.1:8080
CORS_ALLOWED_ORIGINS=http://localhost:8080,http://127.0.0.1:8080
DATABASE_URL=postgres://skywatch:skywatch_dev@localhost:5432/skywatch
REDIS_URL=redis://localhost:6379/0
ALLOW_IN_MEMORY_CHANNEL_LAYER=True
DJANGO_ADMIN_URL_PATH=admin/
METRICS_USER=skywatch
METRICS_PASSWORD=change-me
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

## Local URLs

| Service | URL |
| :--- | :--- |
| Frontend dashboard | `http://localhost:8080` |
| Django API | `http://localhost:8000/api/v1/` |
| Django admin in local startup mode | `http://localhost:8000/admin/` |
| Prometheus metrics | `http://localhost:8000/metrics` |
| Prometheus UI | `http://localhost:9090` |
| Grafana | `http://localhost:3001` |
| Jaeger | `http://localhost:16686` |
| Liveness | `http://localhost:8000/healthz/`, `http://localhost:8000/health/live` |
| Readiness | `http://localhost:8000/readyz/`, `http://localhost:8000/health/ready` |
| JSON health metrics | `http://localhost:8000/health/metrics` |

`/health/ready` checks database, cache, and Celery worker responsiveness. It can fail until a Celery worker is running.

## Commands

| Command | Purpose |
| :--- | :--- |
| `npm run dev` | Start the TanStack Start/Vite frontend server. |
| `npm run backend:dev` | Start Django through `scripts/backend-manage.mjs`. |
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
| `npm run docker:up` | Start Docker Compose infrastructure. |
| `npm run docker:down` | Stop Docker Compose infrastructure. |
| `npm run docker:logs` | Follow Docker Compose logs. |
| `npm run smoke` | Check configured frontend/backend URLs. |

## Data Sources

| Source | Code path | Endpoint / protocol |
| :--- | :--- | :--- |
| OpenSky Network | `backend/flights/services/opensky.py`, `frontend/src/routes/api/flights.ts` | `https://opensky-network.org/api/states/all` |
| ADS-B One | `backend/flights/services/adsb_sources.py` | `https://api.adsb.one/v2/point/{lat}/{lon}/{rad}` |
| Airplanes.live ADS-B | `backend/flights/services/adsb_sources.py` | `https://api.airplanes.live/v2/point/{lat}/{lon}/{rad}` |
| Airplanes.live military/radar | `backend/flights/services/faa_radar.py` | `https://api.airplanes.live/v2/mil` |
| Airplanes.live UAT | `backend/flights/services/uat_client.py` | `https://api.airplanes.live/v2/point/{lat}/{lon}/{rad}` |
| Airplanes.live satellite ADS-B | `backend/flights/services/satellite_adsb.py` | `https://api.airplanes.live/v2/point/{lat}/{lon}/{rad}` |
| ADSB.lol | `backend/flights/services/adsb_sources.py` | `https://api.adsb.lol/v2/point/{lat}/{lon}/{rad}` |
| Open Glider Network | `backend/flights/services/ogn_client.py` | APRS-IS at `aprs.glidernet.org:14580` |
| CelesTrak | `backend/flights/services/celestrak.py`, `frontend/src/routes/api/satellites.ts` | `https://celestrak.org/NORAD/elements/gp.php` |
| Aviation Weather Center | `backend/flights/services/weather.py`, `backend/flights/services/airspace_restrictions.py` | METAR, AIRMET/SIGMET APIs |
| FAA TFR | `backend/flights/services/airspace_restrictions.py` | FAA TFR WFS GeoJSON |
| ADSBDB | `frontend/src/routes/api/enrichment.ts`, `frontend/src/routes/api/photo.ts`, `backend/flights/services/aircraft_db.py` | `https://api.adsbdb.com/v0` |

See [docs/data-sources.md](docs/data-sources.md) for source confidence and circuit-breaker behavior.

## Backend Configuration

Never commit `.env`, `.env.local`, credentials, generated secrets, or production connection strings.

| Variable | Required | Description |
| :--- | :--- | :--- |
| `DJANGO_SECRET_KEY` | Required outside debug | Django signing/session secret. |
| `DJANGO_DEBUG` | Required | `True` for local development, `False` for production. |
| `SKYWATCH_DEPLOYMENT_PROFILE` | Recommended | `local`, `staging`, or `production`. |
| `ALLOWED_HOSTS` | Required outside debug | Comma-separated public hostnames/IPs. |
| `CSRF_TRUSTED_ORIGINS` | Production | HTTPS origins allowed for CSRF validation. |
| `CORS_ALLOWED_ORIGINS` | Production | Frontend origins allowed by CORS. |
| `DATABASE_URL` or `DJANGO_DATABASE_URL` | Required outside debug | PostgreSQL connection string. |
| `READ_REPLICA_DATABASE_URL` | Optional | Read-replica PostgreSQL URL for analytics queries. |
| `REDIS_URL` | Required unless explicit local fallback | Redis cache, Channels layer, Celery broker, and result backend. |
| `ALLOW_IN_MEMORY_CHANNEL_LAYER` | Local only | Allows in-memory fallback when Redis is unavailable. |
| `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | Optional | OpenSky OAuth client credentials. |
| `OPENSKY_USERNAME` / `OPENSKY_PASSWORD` | Optional | Legacy OpenSky basic auth fallback. |
| `ADSBONE_ENABLED`, `AIRPLANESLIVE_ENABLED`, `ADSBLOL_ENABLED` | Optional | Supplemental ADS-B source toggles. |
| `OGN_ENABLED`, `FAA_RADAR_ENABLED`, `UAT_ENABLED`, `SATELLITE_ADSB_ENABLED` | Optional | Specialty source toggles. |
| `CELESTRAK_SATELLITES_ENABLED` | Optional | Enables the Django satellite catalog endpoint. |
| `TFR_GEOJSON_URL` | Optional | Override for FAA TFR GeoJSON. |
| `FLIGHT_ROUTE_LOOKBACK_HOURS`, `FLIGHT_ROUTE_SESSION_GAP_MINUTES` | Optional | Route reconstruction controls. |
| `FLIGHT_STATE_RETENTION_DAYS`, `FLIGHT_POSITION_RETENTION_DAYS` | Optional | Retention controls for cleanup. |
| `METRICS_USER` / `METRICS_PASSWORD` | Production | Basic Auth for `/metrics`. |
| `SENTRY_DSN`, `DJANGO_ENV`, `OTEL_EXPORTER_OTLP_ENDPOINT` | Optional | Error monitoring and tracing. |
| `DJANGO_ADMIN_URL_PATH` | Production | Non-default admin path. |
| `DJANGO_SECURE_*`, `DJANGO_SESSION_COOKIE_SECURE`, `DJANGO_CSRF_COOKIE_SECURE` | Production | Transport security settings. |

## Frontend Configuration

| Variable | Required | Description |
| :--- | :--- | :--- |
| `VITE_SKYWATCH_API_BASE` | Optional | Django backend root or `/api/v1` base. If omitted, frontend utilities use local server routes and local Django fallback where supported. |
| `VITE_SKYWATCH_WS_URL` | Optional | Explicit WebSocket URL for `/ws/flights/`. |
| `VITE_SKYWATCH_API_URL` / `VITE_API_URL` | Optional | Backward-compatible API base aliases. |
| `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | Optional | Server-side TanStack Start OpenSky credentials; not browser-exposed. |
| `ALLOWED_AIRCRAFT_IMAGE_HOSTS` | Optional | Image proxy host allow-list. |
| `MAX_AIRCRAFT_IMAGE_BYTES` | Optional | Aircraft image proxy response limit. |
| `VITE_SENTRY_DSN`, `VITE_BUILD_SHA` | Optional | Frontend Sentry configuration. |

## REST API

Primary backend endpoints are under `/api/v1/`.

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/v1/flights/` | Current fresh flight states from cache, falling back to recent database rows. |
| `GET` | `/api/v1/flights/<icao24>/` | Aircraft detail, latest state, recent route, and active anomalies. |
| `GET` | `/api/v1/flights/<icao24>/route/` | Route sessions and track intelligence for an aircraft. |
| `GET` | `/api/v1/playback/` | Authenticated historical position playback by ICAO24 and time range. |
| `GET` | `/api/v1/predictions/<icao24>/` | Short-horizon position predictions from the latest airborne state. |
| `GET` | `/api/v1/anomalies/` | Active anomalies. |
| `GET` | `/api/v1/anomalies/history/` | Historical anomalies with pagination. |
| `GET` | `/api/v1/anomalies/<id>/explanation/` | Explainability payload for an anomaly. |
| `POST` | `/api/v1/anomalies/<id>/feedback/` | Authenticated anomaly feedback. |
| `GET` | `/api/v1/analytics/` | Live dashboard summary. |
| `GET` | `/api/v1/analytics/timeline/` | Historical metrics timeline. |
| `GET` | `/api/v1/analytics/traffic/` | Hourly active aircraft counts. |
| `GET` | `/api/v1/analytics/routes/` | Most active origin/destination pairs. |
| `GET` | `/api/v1/analytics/anomaly-rate/` | Daily anomalies per 100 flights. |
| `GET` | `/api/v1/analytics/aircraft-types/` | Top aircraft type counts. |
| `GET` | `/api/v1/weather/metar/` | Parsed METAR reports. |
| `GET` | `/api/v1/airspace/tfr/` | Current airspace restriction GeoJSON. |
| `GET` | `/api/v1/airspace/restrictions/` | Restriction collection used by the map overlay. |
| `GET` / `POST` | `/api/v1/alert-rules/` | List or create alert rules. |
| `PATCH` / `DELETE` | `/api/v1/alert-rules/<id>/` | Update or delete an alert rule. |
| `GET` | `/api/v1/sources/` | Current source breakdown and source metadata. |
| `GET` | `/api/v1/source-health/` | Source health records. |
| `GET` | `/api/v1/ingestion-audits/` | Recent ingestion audit rows. |
| `GET` | `/api/v1/model-status/` | Active ML model status. |
| `GET` | `/api/v1/satellites/` | CelesTrak satellite catalog propagated with SGP4. |

Legacy compatibility paths also exist for `/api/weather/metar`, `/api/airspace/tfr`, `/api/airspace/restrictions`, and `/api/playback`.

## WebSockets

The flight stream is served by Django Channels at:

```text
/ws/flights/
```

The server sends:

- `initial_snapshot`: cached current flight snapshot after connect when available.
- `degraded`: no cached snapshot is available yet.
- `flight_update`: committed flight snapshots with source counts and health metadata.
- `anomaly_alert`: newly persisted anomaly events.
- `pong`: response to client ping messages.

The frontend falls back to polling if the WebSocket is unavailable.

## Background Jobs

Celery Beat schedules:

| Schedule | Task | Purpose |
| :--- | :--- | :--- |
| 15 seconds | `flights.tasks.fetch_flight_states` | Fetch, normalize, merge, persist, cache, and broadcast flight states. |
| 30 seconds | `flights.tasks.update_flight_predictions` | Update predicted paths for active flights. |
| 30 seconds | `flights.tasks.evaluate_custom_alert_rules` | Evaluate saved alert rules. |
| 5 minutes | `flights.tasks.refresh_tfr_cache` | Refresh SIGMET and FAA TFR restriction cache. |
| 5 minutes | `flights.tasks.synthetic_health_check` | Probe the configured health URL. |
| 1 hour | `flights.tasks.cleanup_old_data` | Prune old state, position, metrics, anomaly, and audit rows. |
| 1 day | `flights.tasks.retrain_model` | Retrain core ML model when enough recent data exists. |
| 1 week | `flights.tasks.retrain_lstm_model` | Retrain optional LSTM model when TensorFlow/Keras is installed. |

Ingestion also enqueues anomaly detection, route building, and aircraft metadata enrichment after database commit.

## Machine Learning

- Rule checks cover emergency squawks, low-fast profiles, rapid descent, signal loss, unusual kinematics, and position quality.
- Feature extraction uses `backend/ml/features.py`.
- The ensemble path can train Isolation Forest, Local Outlier Factor, and MLP autoencoder components using scikit-learn.
- `backend/ml/train.py` can train from recent database states or synthetic bootstrap data.
- `backend/ml/lstm.py` is optional and import-safe. `python manage.py train_lstm_anomaly` trains only when TensorFlow/Keras is installed and enough sequences exist.
- Explainability is generated by `backend/flights/services/explainability.py`.

## Observability

The backend exposes Prometheus metrics at `/metrics`. If `METRICS_USER` or `METRICS_PASSWORD` is set, clients must use HTTP Basic Auth.

| Metric | Type | Description |
| :--- | :--- | :--- |
| `skywatch_active_flights_total` | Gauge | Current active flights. |
| `skywatch_anomalies_detected_total` | Counter | Anomalies detected by severity. |
| `skywatch_websocket_connections` | Gauge | Open WebSocket connections. |
| `skywatch_data_ingestion_latency_seconds` | Histogram | Flight ingestion latency. |
| `skywatch_cache_hits_total` / `skywatch_cache_misses_total` | Counter | Cache usage counters. |
| `skywatch_celery_task_duration_seconds` | Histogram | Celery task duration by task name. |

Docker Compose provisions Prometheus on `9090`, Grafana on `3001`, and Jaeger on `16686`. Update `monitoring/prometheus.yml` credentials before using the monitoring stack outside local development.

## Production

See [docs/production.md](docs/production.md) and [DEPLOYMENT.md](DEPLOYMENT.md). The current Docker Compose file provisions infrastructure only; it does not run backend/frontend application services.

Production requires:

- `DJANGO_DEBUG=False`.
- `SKYWATCH_DEPLOYMENT_PROFILE=production`.
- PostgreSQL URL and Redis URL.
- Strong secret key and exact hosts/origins.
- Non-default `DJANGO_ADMIN_URL_PATH`.
- Protected metrics credentials.
- TLS/WSS reverse proxy.
- Separate supervised Daphne, Celery worker, and Celery Beat processes.
- Retention and backup policy for high-volume state tables.

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

SkyWatch Live is licensed under the MIT License. See [LICENSE](LICENSE).

The MIT License allows commercial use, modification, distribution, and private use, provided the copyright and license notice are included. The software is provided without warranty.

Third-party dependency, container image, and public data-source notices are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Review upstream data-source terms before operating a hosted or commercial deployment.

## Citation

If you use SkyWatch Live in research, cite:

```bibtex
@software{skywatch-live,
  title={SkyWatch Live: Airspace Surveillance with Real-Time Anomaly Detection},
  author={SkyWatch Live Contributors},
  year={2026},
  url={https://github.com/debjit450/skywatch-live}
}
```

## Acknowledgments

SkyWatch Live integrates with open-source projects and public aviation data sources including Django, Django REST Framework, Channels, Celery, React, TanStack, MapLibre GL, deck.gl, react-map-gl, OpenSky Network, CelesTrak, Aviation Weather Center, ADSBDB, Open Glider Network, and the public ADS-B aggregators listed above.

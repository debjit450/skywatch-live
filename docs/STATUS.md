# SkyWatch Live Status

Last reviewed: 2026-05-24.

## Verification Snapshot

This documentation and license-audit pass verified the repository against the current code/configuration source of truth.

| Check | Result |
| :--- | :--- |
| `npm run check` | Passed. Frontend TypeScript, ESLint, and production client/server build completed. |
| `npm run backend:check` with local debug env | Passed with no system-check issues. |
| `npm run backend:test` with local debug env | Passed. Django ran 7 tests successfully. |
| `node scripts/backend-manage.mjs makemigrations --check --dry-run` with local debug env | Passed with no migration changes detected. |
| `npm run backend:check-deploy` with production-like env overrides | Exited successfully. It reported drf-spectacular schema warnings for APIViews without explicit serializers and an operationId collision warning; no blocking Django deployment errors were raised. |

Notes:

- The first backend test attempt failed because `backend/venv` existed without Django installed. Backend requirements were installed into the ignored local venv and the command was rerun successfully.
- Backend tests emitted OpenTelemetry export warnings because no local collector was listening on `localhost:4317`; the tests still passed.
- Docker Compose was not started during this pass.

## Works Today

- Frontend-only TanStack Start dashboard using server routes for OpenSky flights, CelesTrak satellites, ADSBDB metadata/photos, and OpenSky track lookups.
- MapLibre/deck.gl dashboard with source-aware aircraft rendering, overlays, filters, detail panels, analytics, alert-rule UI, and satellite/weather/restriction layers.
- Django REST API under `/api/v1/` for flights, routes, predictions, anomalies, analytics, weather, airspace, alert rules, sources, source health, ingestion audits, model status, and satellites.
- Django Channels WebSocket stream at `/ws/flights/` for initial snapshots, committed flight updates, anomaly alerts, and ping/pong health traffic.
- Celery ingestion pipeline merging OpenSky with enabled supplemental sources, persisting state/history, caching current snapshots, broadcasting WebSocket updates, and enqueueing anomaly/route/enrichment work after commit.
- Prometheus metrics at `/metrics`, JSON health metrics at `/health/metrics`, optional Sentry, optional OpenTelemetry export, and Grafana/Prometheus/Jaeger local provisioning.

## Degraded By Public API Limits

- OpenSky public access can throttle or return sparse regional coverage. Credentials improve rate limits but do not guarantee full receiver coverage.
- Supplemental ADS-B, UAT, OGN, satellite ADS-B, and military/radar aggregate coverage depends on public receiver density and upstream availability.
- ADSBDB metadata/photo availability is non-critical and upstream-dependent.
- CelesTrak fallback TLEs keep the satellite visualization usable when the live source is unavailable, but fallback records can become stale.

## Full-Stack Infrastructure Dependencies

The complete ingestion path depends on:

- PostgreSQL for durable aircraft, state, position, route, anomaly, audit, and model records.
- Redis for cache, Django Channels, Celery broker, and Celery result backend.
- Celery worker plus Celery Beat for background ingestion, scoring, alert evaluation, cleanup, and model retraining.
- Optional PgBouncer for database pooling under higher concurrency.
- Optional Prometheus, Grafana, and Jaeger for local observability.

Local debug mode can use SQLite and in-memory cache/channel fallbacks when `DJANGO_DEBUG=True` and `ALLOW_IN_MEMORY_CHANNEL_LAYER=True`. Production blocks that fallback.

## Documentation Changes In This Pass

- Updated README, quick start, deployment, testing, troubleshooting, support, security, contributing, data-source, development, production, status, and architecture docs.
- Added [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
- Corrected architecture diagrams for MapLibre/deck.gl, TanStack Start server routes, Django REST/Channels, Celery, Redis, PostgreSQL, Prometheus, Grafana, and Jaeger.
- Corrected the frontend local port from stale `5173` references to the configured Vite port `8080`.
- Corrected Docker Compose wording: the current Compose file provisions infrastructure, not backend/frontend application services.
- Corrected source merge behavior documentation to match the code path: freshest `last_contact` wins per ICAO24, while provenance/conflict/source-health metadata is retained.

# Third-Party Notices

Last reviewed: 2026-05-24.

SkyWatch Live itself is licensed under the MIT License. See [LICENSE](LICENSE).

This file documents third-party software and public data-source surfaces used by the repository. It is not a substitute for reviewing each dependency's current license and terms before redistribution, managed hosting, or commercial use.

## Project License Metadata

| File | Value |
| :--- | :--- |
| `LICENSE` | MIT License, copyright 2024-2026 SkyWatch Live Contributors |
| `package.json` | `license: MIT` |
| `frontend/package.json` | `license: MIT`, `private: true` |
| `backend/pyproject.toml` | `license = {text = "MIT"}` |

## Direct Frontend Runtime Dependencies

Source of truth: `frontend/package.json`.

| Package | Purpose |
| :--- | :--- |
| `@deck.gl/core`, `@deck.gl/layers`, `@deck.gl/mapbox` | WebGL map overlay rendering. |
| `@radix-ui/react-select`, `@radix-ui/react-tabs` | Accessible UI primitives. |
| `@sentry/react` | Optional frontend error monitoring. |
| `@tanstack/react-query`, `@tanstack/react-router`, `@tanstack/react-start`, `@tanstack/react-virtual`, `@tanstack/router-plugin` | Frontend data fetching, routing, SSR/server route framework, and virtualization. |
| `intro.js` | Guided UI tour support. |
| `lucide-react` | Icon set. |
| `maplibre-gl`, `react-map-gl` | Map rendering and React bindings. |
| `react`, `react-dom` | UI runtime. |
| `react-grid-layout` | Dashboard grid layout. |
| `recharts` | Charts and analytics visualization. |
| `satellite.js` | SGP4 satellite propagation. |
| `ws` | WebSocket support for server-side/runtime paths. |

Frontend development dependencies include Vite, TypeScript, ESLint, Prettier, Tailwind CSS Vite integration, React/Vite plugins, and type packages as listed in `frontend/package.json`.

## Direct Backend Dependencies

Source of truth: `backend/requirements.txt`.

| Package | Purpose |
| :--- | :--- |
| `django`, `djangorestframework`, `drf-spectacular`, `django-cors-headers` | Web framework, REST API, OpenAPI, and CORS. |
| `psycopg[binary]` | PostgreSQL driver. |
| `channels`, `channels-redis`, `daphne`, `websockets` | ASGI and WebSocket support. |
| `celery`, `django-celery-beat`, `redis`, `eventlet` | Background jobs, schedules, broker/cache, and worker support. |
| `scikit-learn`, `joblib`, `numpy`, `scipy` | Machine-learning and numerical processing. |
| `requests`, `python-dotenv`, `sgp4` | HTTP clients, env loading, and satellite propagation. |
| `sentry-sdk[django,celery]` | Optional backend error monitoring. |
| `opentelemetry-*` | Optional tracing instrumentation and export. |
| `django-prometheus`, `prometheus-client` | Metrics export. |
| `structlog` | Structured logging. |
| `pip-audit` | Dependency vulnerability auditing. |

TensorFlow/Keras is optional for LSTM training and is intentionally not part of the default requirements.

## Infrastructure Images

Source of truth: `docker-compose.yml`, `backend/Dockerfile`, and `frontend/Dockerfile`.

| Image | Purpose |
| :--- | :--- |
| `python:3.11-slim` | Backend image base. |
| `node:22-alpine` | Frontend build/runtime image base. |
| `postgres:16-alpine` | Local PostgreSQL. |
| `public.ecr.aws/bitnami/pgbouncer:1.24.1` | Local PgBouncer. |
| `redis:7-alpine` | Local Redis. |
| `jaegertracing/all-in-one:1.57` | Local tracing. |
| `prom/prometheus:v2.54.1` | Local metrics scraping. |
| `grafana/grafana:11.1.4` | Local dashboards. |

## Public Data Sources and APIs

SkyWatch Live integrates with public data providers. Their availability, license, acceptable-use policy, attribution requirements, rate limits, and commercial-use terms can change independently of this repository.

| Source | Used for |
| :--- | :--- |
| OpenSky Network | Flight states, optional aircraft route/history, optional aircraft metadata CSV. |
| ADS-B One | Supplemental ADS-B point feeds. |
| Airplanes.live | ADS-B point feeds, military/radar aggregate, UAT/TIS-B filtering, and oceanic/satellite ADS-B heuristics. |
| ADSB.lol | Supplemental ADS-B point feeds. |
| Open Glider Network | FLARM/OGN glider and small-aircraft APRS stream. |
| CelesTrak | Satellite GP/TLE element sets. |
| Aviation Weather Center | METAR and SIGMET data. |
| FAA TFR feeds | Temporary flight restriction GeoJSON. |
| ADSBDB | Aircraft metadata and photo lookup/proxy support. |
| OurAirports-derived data | Airport metadata generation path under `frontend/scripts/generate-airport-data.mjs` and generated TypeScript data. |

Review provider terms before publishing a hosted service, redistributing cached data, using the project commercially, or combining feeds with proprietary data.

## Generated and Ignored Artifacts

These are not intended to be redistributed as source artifacts:

- `frontend/node_modules/`
- `backend/venv/`
- build outputs such as `dist`, `.output`, `.vinxi`, and `.tanstack/`
- local env files such as `.env`, `.env.local`, and `backend/.env`
- local SQLite databases
- generated ML model files under `backend/ml/models/`
- downloaded aircraft metadata CSV files

## Maintainer Checklist

Before publishing a release or distribution:

1. Confirm `LICENSE`, `package.json`, `frontend/package.json`, and `backend/pyproject.toml` still agree on project license metadata.
2. Review direct dependency license changes from `frontend/package-lock.json` and Python package metadata.
3. Recheck public data-source terms for hosted or commercial use.
4. Include this notice file with source distributions.

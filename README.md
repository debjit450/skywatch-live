# SkyWatch Live ✈️🛰️

SkyWatch Live is a real-time, professional-grade aircraft surveillance and flight tracking platform. Built with a modern **TypeScript (React 19, TanStack Start, Leaflet)** frontend and a robust **Python (Django 5, Celery, Daphne ASGI, Channels)** ingestion backend, SkyWatch processes live transponder data from multiple ADS-B, UAT, and radar sources to detect behavioral anomalies, estimate flight trajectories, and deliver real-time visual dashboards.

This project is organized as a clean, decoupled monorepo layout, separating the frontend and backend applications to ensure seamless scaling, isolated deployment processes, and a developer-friendly codebase.

---

## 📖 Contents

- [System Architecture](#-system-architecture)
- [Repository Layout](#-repository-layout)
- [Prerequisites](#-prerequisites)
- [Quick Start](#-quick-start)
- [Environment Configuration](#-environment-configuration)
- [Development Commands](#-development-commands)
- [Backend & Data Ingestion Pipeline](#-backend--data-ingestion-pipeline)
- [Machine Learning & Anomaly Detection](#-machine-learning--anomaly-detection)
- [API Reference](#-api-reference)
- [Production Deployment & DevOps](#-production-deployment--devops)
- [Security Checklist](#-security-checklist)
- [Troubleshooting](#-troubleshooting)

---

## 🏛️ System Architecture

SkyWatch Live supports two distinct operational modes:

### 1. Frontend-Only Mode (Serverless/Mock)
- **Runtime**: Serves the React single-page application using TanStack Start server routes under `frontend/src/routes/api`.
- **Feed Ingestion**: Proxies real-time OpenSky data directly through `/api/flights` server endpoints.
- **Dependency Scope**: Fully standalone. Requires zero database, Redis, Celery, or Django servers. Perfect for prototyping, visual tuning, and static edge deployments.

### 2. Full-Stack Production Mode
- **Ingestion Backend**: A Python Django backend ingests from multiple public and private state feeds (OpenSky, ADS-B One, Airplanes.live, etc.), maintains active state layers, clusters flight routes, and logs flight intelligence.
- **Real-Time Synchronizer**: Uses Django Channels backed by a high-performance Redis channel layer to broadcast live aircraft transponder updates and critical flight alerts to thousands of connected browser sockets instantly.
- **Distributed Async Pipeline**: Celery workers run non-blocking ingestion cycles, bulk-persist flight positions, execute asynchronous anomaly checks, and periodically retrain machine learning models.
- **Machine Learning Core**: Scikit-Learn Isolation Forests run asynchronously to scan incoming flight paths for spatial and behavioral anomalies (e.g., squawk changes, military alerts, path deviations).

```text
               +--------------------------------------------------------+
               |                  Surveillance Clients                  |
               +--------------------------------------------------------+
                        | (HTTPS API)                    ^ (WebSockets)
                        v                                |
         +----------------------------+        +-------------------+
         |       TanStack Start       |        |  Daphne ASGI Web  |
         |    Frontend application    |        |   Django Server   |
         +----------------------------+        +-------------------+
                                                        |
                                                        v
                                               +-------------------+
                                               |  Redis Pub/Sub    |
                                               |  & Cache Layer    |
                                               +-------------------+
                                                  ^             ^
                                                  |             |
                                      (Job Queue) |             | (Cache & Sync)
                                                  v             v
+------------------------+                     +-------------------+
|  Celery Beat Scheduler  |===================> |   Celery Worker   |
+------------------------+                     +-------------------+
                                                        |
                                                        v
                                               +-------------------+
                                               | PostgreSQL RDBMS  |
                                               +-------------------+
```

---

## 📁 Repository Layout

The codebase uses a clean split-monorepo directory structure, isolating dependencies, builds, and runtimes:

```text
.
├── .github/                # GitHub Actions Workflows for Frontend and Backend CI
├── backend/                # Django Backend Service
│   ├── flights/            # Django app: REST APIs, models, async tasks, websocket consumers
│   ├── ml/                 # Machine Learning models, anomaly detection & feature extractors
│   ├── skywatch/           # Django core: setting configurations, ASGI/WSGI, Celery setup
│   ├── manage.py           # Django CLI entrypoint
│   └── requirements.txt    # Python production dependencies list
├── frontend/               # React Frontend Service
│   ├── dist/               # Production build output
│   ├── node_modules/       # Node.js dependencies
│   ├── scripts/            # Frontend specific utility scripts
│   ├── src/                # TanStack Start / React application code
│   │   ├── components/     # Reusable UI widgets and layout modules
│   │   ├── hooks/          # Global React hooks
│   │   ├── lib/            # Utilities (enrichment, aircraft definitions, filters)
│   │   └── routes/         # TanStack File-Based Routing structure
│   ├── eslint.config.js    # Linter rules
│   ├── package.json        # Frontend NPM script manifest and dependencies
│   ├── tsconfig.json       # TypeScript configuration
│   └── vite.config.ts      # Vite bundler options
├── scripts/                # Root-level orchestrator scripts
│   ├── backend-manage.mjs  # CLI wrapper to manage backend tasks from root
│   └── dev-all.mjs         # Multi-process dev orchestrator
├── docker-compose.yml      # Local dev environment helper (PostgreSQL + Redis)
├── package.json            # Root configuration for monorepo routing and setup
├── startup.bat             # Windows menu setup and execution tool
├── startup.ps1             # PowerShell script automating development environment setup
├── QUICKSTART.md           # Quick setup reference guide
└── README.md               # Main repository documentation (this file)
```

---

## ⚡ Prerequisites

To run SkyWatch Live locally or in production, ensure your environment meets these conditions:

### Development Environment (Local)
* **Node.js**: `v22.0.0` or higher
* **npm**: `v10.0.0` or higher
* **Python**: `v3.11.x` or higher
* **Docker Desktop**: Required to orchestrate PostgreSQL and Redis out of the box.

### Production Environment (Recommended)
* **Database**: Managed PostgreSQL 16+
* **Cache & Broker**: Managed Redis 7+
* **Process Manager**: Separate runtimes for Web/ASGI (`Daphne`), Celery Worker, and Celery Beat scheduler.
* **TLS / SSL**: Handled via cloud load balancers or high-performance reverse proxies like Nginx or Traefik.

---

## 🚀 Quick Start

SkyWatch includes an automated launcher that bootstraps your workspace, sets up database containers, generates local credentials, and configures environments in seconds.

### Automated Setup (Windows)

1. Open PowerShell and run the setup script:
   ```powershell
   npm run startup
   ```
   *(This launches Docker containers for PG and Redis, provisions a Python virtual environment, installs front/back dependencies, and migrates the database).*

2. Launch both servers in concurrently managed shells:
   ```powershell
   npm run dev-all
   ```

### Manual Setup (Multi-Platform / Linux / macOS)

1. **Configure Backend**:
   ```bash
   cd backend
   python -m venv venv
   source venv/bin/activate  # Windows: .\venv\Scripts\Activate.ps1
   pip install --upgrade pip
   pip install -r requirements.txt
   cp .env.example .env
   python manage.py migrate
   cd ..
   ```

2. **Configure Frontend**:
   ```bash
   cd frontend
   npm ci
   cp .env.example .env.local
   cd ..
   ```

3. **Orchestrate Local Execution**:
   Start each component in separate terminal windows:
   ```bash
   # Terminal 1: Run Django ASGI
   npm run backend-dev
   
   # Terminal 2: Run Frontend Dev Server
   npm run dev
   ```

Now, navigate to:
* **Frontend Dashboard**: [http://localhost:5173](http://localhost:5173)
* **Backend API Console**: [http://localhost:8000/api/v1/](http://localhost:8000/api/v1/)
* **Django Administration**: [http://localhost:8000/admin/](http://localhost:8000/admin/)

---

## ⚙️ Environment Configuration

Environment files contain sensitive keys and parameters; they are excluded from source control. Copy the template files below and populate them manually.

### Frontend Config (`frontend/.env.local`)
Create `.env.local` inside the `frontend/` directory to configure the Vite build.

| Parameter | Required | Description |
| :--- | :--- | :--- |
| `VITE_SKYWATCH_API_BASE` | No | Target base URL of your Django backend. (e.g., `http://localhost:8000`). If omitted, frontend runs in standalone mode. |
| `VITE_SKYWATCH_WS_URL` | No | Absolute WebSocket connection string (e.g., `ws://localhost:8000/ws/flights/`). |
| `OPENSKY_CLIENT_ID` | No | OpenSky OAuth Application ID (for server route proxy). |
| `OPENSKY_CLIENT_SECRET` | No | OpenSky OAuth Secret Key (for server route proxy). |
| `ALLOWED_AIRCRAFT_IMAGE_HOSTS` | No | Comma-separated domain list allowed in the image proxy. |

---

### Backend Config (`backend/.env`)
Create `.env` inside the `backend/` directory to run the production system.

| Variable | Production Required | Default / Dev | Description |
| :--- | :--- | :--- | :--- |
| `DJANGO_SECRET_KEY` | **Yes** | Generated | Core cryptographic key for sessions and tokens. |
| `DJANGO_DEBUG` | **Yes** | `True` | Disables verbose debug views and stack traces. |
| `ALLOWED_HOSTS` | **Yes** | `localhost,127.0.0.1` | Hostnames and domains matching this server. |
| `CSRF_TRUSTED_ORIGINS` | **Yes** | Empty | Allowed origins for trusted HTTPS requests. |
| `CORS_ALLOWED_ORIGINS` | **Yes** | Dev local hosts | Domains allowed to make client CORS queries. |
| `DATABASE_URL` | **Yes** | `sqlite://` | Absolute connection string to PostgreSQL. |
| `REDIS_URL` | **Yes** | Empty | Redis server location used for Cache/WS/Celery. |
| `OPENSKY_USERNAME` | No | Empty | Basic authentication fallback for OpenSky ingest. |
| `OPENSKY_PASSWORD` | No | Empty | Basic authentication fallback password. |

---

## 🛠️ Development Commands

Orchestrate the monorepo effortlessly using simple top-level shortcuts:

| Command | Workspace | Description |
| :--- | :--- | :--- |
| `npm run dev-all` | Root | Concurrently runs both the Vite dev server and the backend API. |
| `npm run dev` | Frontend | Launches the frontend application standalone. |
| `npm run backend-dev` | Backend | Launches the Django API server directly. |
| `npm run startup` | Root | Automates Windows setup (Docker, migrations, env, pip, npm). |
| `npm run check` | Frontend | Combines typescript validation, linting, and compiler build. |
| `npm run lint` | Frontend | Executes ESLint & Prettier code quality checks. |
| `npm run typecheck` | Frontend | Performs isolated compiler type safety analysis. |
| `npm run backend:migrate` | Backend | Runs all outstanding database schema migrations. |
| `npm run backend:check` | Backend | Invokes Django system check checks. |
| `npm run backend:check-deploy` | Backend | Evaluates Django settings against security standard specs. |
| `npm run generate:airports` | Frontend | Compiles and updates internal static airport indexes. |

---

## 📡 Backend & Data Ingestion Pipeline

SkyWatch utilizes an intelligent ingestion coordinator designed to persist high-volume sensor telemetry with zero lag or locking contention.

### Multi-Feed Aggregator
Rather than relying on a single transponder API, SkyWatch maps multiple telemetry signals into a single standardized flight envelope:
1. **OpenSky Network API**: Main commercial feed for overall live state matrices.
2. **ADS-B One & Airplanes.live**: Raw crowdsourced aircraft data feeds.
3. **Open Glider Network (OGN)**: Focuses on low-altitude glider, drone, and light aircraft tracking.
4. **FAA Radar & UAT Feeds**: High-precision civil and military transponder logs.

### Database Optimization & Batch Operations
To prevent database connection bottlenecks during intense write cycles, SkyWatch avoids N+1 queries by leveraging **Django bulk operations**:
* Live flight records are batched and written to PostgreSQL using `bulk_create` with conflict updates (`update_conflicts=True`).
* Active routing histories are cached and grouped, keeping database updates to highly optimized intervals rather than single-record transactions.
* Uses **Redis Connection Pool isolation** to prevent memory exhaustion under concurrent WebSocket request traffic.

---

## 🧠 Machine Learning & Anomaly Detection

SkyWatch evaluates raw transponder logs to immediately recognize behavioral deviations, providing surveillance operators with crucial insights.

```text
Telemetry Ingest ---> Feature Normalization ---> Isolation Forest Engine ---> Anomaly Scoring ---> WebSocket Broadcast
```

### Anomaly Scoring Metrics
Anomalies are scored based on multiple features:
* **Spatial Deviations**: Sudden unexpected changes in altitude or rate of climb/descent.
* **Squawk Codes**: Automatic flagging of critical emergency transponder codes (e.g., `7500` Hijack, `7600` Comm Failure, `7700` Emergency).
* **Military & Special States**: Automatic tagging of combatants, government transports, or aircraft without active flight plans.
* **ML Deviation Score**: Evaluated using an **Isolation Forest** model that looks for unusual spatial features relative to normal flight routes.

---

## 🔌 API Reference

### Frontend Proxy Endpoints
Served natively by the TanStack Start framework (e.g., `http://localhost:5173/api/...`):
* `GET /api/flights`: Live flights from OpenSky proxy.
* `GET /api/flight-track?icao24=<HEX>`: Historic track points.
* `GET /api/enrichment?icao24=<HEX>&callsign=<STR>`: Retrieves aircraft registration, owner, and route data.
* `GET /api/photo?url=<ENCODED_URL>`: Secure image proxy.

### Backend REST API
Served by Django (e.g., `http://localhost:8000/api/v1/...`):
* `GET /api/v1/flights/`: Active, aggregated flight matrices.
* `GET /api/v1/flights/<icao24>/`: Detailed individual aircraft data.
* `GET /api/v1/anomalies/`: High-alert anomalies feed.
* `GET /api/v1/analytics/`: Detailed statistics and performance metrics.
* `GET /api/v1/predictions/<icao24>/`: Estimated trajectory plots.

### Real-Time WebSocket Channel
Connect to live streaming events:
```text
ws://localhost:8000/ws/flights/
```

---

## 🚢 Production Deployment & DevOps

Deploying SkyWatch to a production environment requires a multi-service structure to handle ingestion, processing, and real-time communication.

### Web Server (Daphne ASGI)
Run the real-time Django server through Daphne to support WebSockets:
```bash
cd backend
daphne -b 0.0.0.0 -p 8000 skywatch.asgi:application
```

### Asynchronous Ingestion & Processing (Celery)
1. **Launch Worker**:
   ```bash
   celery -A skywatch worker -l INFO
   ```
2. **Launch Scheduler (Beat)**:
   ```bash
   celery -A skywatch beat -l INFO
   ```

### Quality Control Check
Before promoting a build to production, ensure these three checks pass:
```bash
# 1. Frontend validation check
npm run check --prefix frontend

# 2. Django Security check
python backend/manage.py check --deploy

# 3. Model migration check
python backend/manage.py makemigrations --check --dry-run
```

---

## 🔒 Security Checklist

- [ ] **Debug Disabled**: Ensure `DJANGO_DEBUG=False` is set in production.
- [ ] **Unique Secret Key**: Ensure `DJANGO_SECRET_KEY` is a strong, unique, rotatable value.
- [ ] **Secure Cookies**: Enable `DJANGO_SESSION_COOKIE_SECURE=True` and `DJANGO_CSRF_COOKIE_SECURE=True`.
- [ ] **HSTS Policy**: Enforce HTTP Strict Transport Security (`SECURE_HSTS_SECONDS`).
- [ ] **Restricted CORS**: Avoid setting wildcards (`*`) for CORS origins in production.
- [ ] **Network Isolation**: Ensure PostgreSQL and Redis are hosted on private networks, inaccessible to the public internet.

---

## 🔧 Troubleshooting

### Local migration cannot connect to PostgreSQL
* Make sure Docker Desktop is active and the containers are running:
  ```bash
  docker compose up -d
  ```
* Verify your `DATABASE_URL` in `backend/.env` matches the configuration in `docker-compose.yml`.

### Frontend not displaying backend data
* Check your `frontend/.env.local` to ensure `VITE_SKYWATCH_API_BASE` is set and points to your active Django backend.
* Restart the frontend development server after updating your env variables.

### WebSocket connection issues
* Ensure your reverse proxy (e.g. NGINX) is configured to handle WebSocket upgrades:
  ```nginx
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  ```
* Ensure you are using `wss://` instead of `ws://` in HTTPS production environments.

---

*SkyWatch Live - Professional Real-Time Flight Surveillance System. Created for high-performance and reliable air traffic tracking.*

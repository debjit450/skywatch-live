# 🚀 SkyWatch Live Quick Start

<div align="center">

**Get your real-time global airspace surveillance engine up and running in minutes!**

[![React](https://img.shields.io/badge/React-20232A?style=flat-square&logo=react&logoColor=61DAFB)](https://react.dev)
[![Django](https://img.shields.io/badge/Django-092E20?style=flat-square&logo=django&logoColor=white)](https://djangoproject.com)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)

</div>

---

## ⚡ Automated Windows Bootstrapping (Recommended)

If you are developing on a Windows system, we have built a fully automated setup pipeline that creates environment variables, spins up containers, configures virtual environments, and installs dependencies with one command.

Run this from the repository root:

```powershell
npm run startup
```

### 🛠️ What Happens Under the Hood?
- 🔑 Generates `.env.local` for the React frontend and `backend/.env` for Django with secure local defaults.
- 🐳 Starts regional database (`PostgreSQL 16`) and caching layer (`Redis 7`) using Docker Compose.
- 📦 Installs root, client, and server dependencies.
- 🐍 Creates a Python virtual environment (`backend/venv`) and installs pip packages.
- ⚙️ Runs Django migrations to initialize database models.

Once completed, start all dev servers with:

```powershell
npm run dev-all
```

Access your dashboard at:  
👉 **Frontend Dashboard**: [http://localhost:5173](http://localhost:5173)  
👉 **Backend REST API**: [http://localhost:8000/api/v1/](http://localhost:8000/api/v1/)  
👉 **Django Admin Portal**: [http://localhost:8000/admin/](http://localhost:8000/admin/)

---

## 📦 Rapid Setup Without Docker (SQLite Mode)

If you do not have Docker installed or want to skip the container layer for quick UI experimentation, run the rapid in-memory database configuration:

```powershell
npm run startup:nodock
npm run dev-all
```

> [!NOTE]
> **Database Fallback**: This mode automatically spins up a local `SQLite` database and uses an in-memory cache backend instead of Redis. This is excellent for rapid prototyping but **must not** be used for high-concurrency production deployments.

---

## 💻 Primary Development Commands

| Command | Environment | Context / Intent |
| :--- | :--- | :--- |
| `npm run dev` | 🎨 Frontend-Only | Runs the TanStack Start React server with mocked/proxied API routes. |
| `npm run backend-dev` | 🐍 Backend-Only | Launches only the Django REST framework / Channels web application. |
| `npm run dev-all` | 🚀 Full-Stack | Spawns both the frontend client and Django server concurrently. |
| `npm run check` | 🧪 Frontend Audit | Performs type-checking, lints, and verifies the production build. |
| `npm run backend:migrate` | ⚙️ Database | Applies database migrations to Postgres/SQLite. |
| `npm run backend:check-deploy`| 🛡️ Security | Verifies settings for secure production configurations. |

---

## 🚦 Deployment Gate Validation

Prior to pushing changes to production, always verify your code against our standard quality assurance gates:

```powershell
# 1. Typecheck, Lint, and build client
npm run check

# 2. Check server deployment compliance
npm run backend:check-deploy
```

To run dry-run tests for database migration drift inside the Python environment, execute:

```powershell
# Run from repository root
.\backend\venv\Scripts\python.exe backend/manage.py makemigrations --check --dry-run
```

---

> [!TIP]
> **Complete Guides Available**: For advanced production topographies, detailed environment variable catalogs, and extensive security check guidelines, refer to the full [README.md](README.md) file.

# SkyWatch Quick Start Guide

## 🚀 First Time Setup (One Command)

```bash
npm run startup
```

This single command will:

- ✅ Start Docker services (PostgreSQL, Redis)
- ✅ Install frontend dependencies
- ✅ Create Python virtual environment
- ✅ Install backend dependencies
- ✅ Run database migrations
- ✅ Setup environment files

**Note:** Requires Docker, Node.js, and Python to be installed on your system.

## ▶️ Running the Application

After setup, choose one of these options:

### Option 1: All Services in New Windows (Easiest)

```bash
npm run dev-all
```

- Opens frontend in one window
- Opens backend in another window
- Recommended for development

### Option 2: Run Services Individually

Terminal 1 - Frontend:

```bash
npm run dev
```

Terminal 2 - Backend:

```bash
npm run backend-dev
```

## 🔧 Common Commands

| Command                  | Purpose                                       |
| ------------------------ | --------------------------------------------- |
| `npm run startup`        | Complete first-time setup                     |
| `npm run startup:nodock` | Setup without Docker (manual DB setup needed) |
| `npm run dev-all`        | Run frontend + backend together               |
| `npm run dev`            | Frontend only                                 |
| `npm run backend-dev`    | Backend only                                  |
| `npm run build`          | Production build                              |
| `npm run check`          | Typecheck, lint, and build                    |

## 📍 Access Points

- **Frontend:** http://localhost:5173
- **Backend API:** http://localhost:8000
- **Admin Panel:** http://localhost:8000/admin

## 🐛 Troubleshooting

### "Docker not found"

Install Docker Desktop from https://www.docker.com/products/docker-desktop

### "Python not found"

Install Python from https://www.python.org (add to PATH during installation)

### "npm not found"

Install Node.js from https://nodejs.org

### Backend migration errors

```bash
cd backend
.\venv\Scripts\Activate.ps1
python manage.py migrate --run-syncdb
```

### Port already in use

- Frontend (5173): Edit `vite.config.ts`
- Backend (8000): Edit `backend/skywatch/settings.py`
- PostgreSQL (5432): Edit `docker-compose.yml`

## 📝 First-Time Setup Without Docker

If you prefer not to use Docker:

1. Setup PostgreSQL and Redis manually
2. Run: `npm run startup:nodock`
3. Update `backend/.env` with your database credentials

## 🎯 Next Steps

1. Copy `.env.example` to `.env.local` (auto-done by startup)
2. Set API keys in `.env.local` (OpenSky, etc.)
3. Start development with `npm run dev-all`
4. Check out the documentation in the main README.md

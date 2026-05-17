# SkyWatch Live

Live aircraft surveillance dashboard built with TanStack Start, React, Leaflet, and an optional Django ingestion backend.

## Frontend

```bash
npm install
npm run dev
```

Production checks:

```bash
npm run check
```

Copy `.env.example` to `.env.local` for local frontend/runtime secrets. Do not commit real `.env*` files.

## Backend

```bash
cd backend
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
python manage.py migrate
python manage.py runserver
```

For production, set `DJANGO_DEBUG=False`, a real `DJANGO_SECRET_KEY`, `ALLOWED_HOSTS`, `DATABASE_URL`, `REDIS_URL`, and explicit CORS/CSRF origins. Enable HSTS preload only when the domain and all subdomains are HTTPS-ready.

## Deploy Notes

- Frontend builds with `npm run build` and is configured for Cloudflare via `wrangler.jsonc`.
- Keep `package-lock.json` as the single JavaScript lockfile.
- Local databases, virtual environments, build output, logs, caches, and secret env files are ignored.
- Rotate any credentials that were ever stored in a local env file before deploying publicly.

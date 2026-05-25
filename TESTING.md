# Testing Guide

Last reviewed: 2026-05-25.

SkyWatch Live currently uses TypeScript typechecking, ESLint, Vitest frontend unit tests, production builds, Django system checks, Django tests, Docker image builds in CI, and dependency audits.

## Quick Commands

```bash
npm test
npm run check
npm run test:frontend
npm run backend:test
npm run backend:check
npm run backend:check-deploy
```

| Command | Runs |
| :--- | :--- |
| `npm run check` | Frontend typecheck, lint, unit tests, and production build through `frontend/package.json`. |
| `npm run test:frontend` | Frontend Vitest unit tests. |
| `npm run backend:test` | Django test suite through `scripts/backend-manage.mjs`. |
| `npm run backend:check` | Django system checks. |
| `npm run backend:check-deploy` | Django deployment security checks. |
| `npm test` | `npm run check` followed by `npm run backend:test`. |

## Frontend Checks

```bash
npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend run test
npm --prefix frontend run build
npm --prefix frontend run check
```

`npm --prefix frontend run check` is the CI-equivalent frontend command. It runs typechecking, ESLint, Vitest, and a production build. It does not write formatting changes; `npm run format` runs Prettier when you intentionally want to format frontend files.

## Backend Checks

```bash
npm run backend:check
npm run backend:check-deploy
npm run backend:test
```

Run a specific Django test module or class:

```bash
npm run backend:test -- flights.tests
npm run backend:test -- flights.tests.FlightViewTests
```

Check migration drift:

```bash
cd backend
python manage.py makemigrations --check --dry-run
python manage.py migrate --check
```

## Coverage

Coverage tooling is not part of the default dependency set. To measure backend coverage locally:

```bash
cd backend
python -m pip install coverage
coverage run --source='.' manage.py test
coverage report
coverage html
```

Frontend unit tests use Vitest and live next to the code they cover as `*.test.ts` or `*.test.tsx` files.

## CI

`.github/workflows/ci.yml` runs on pushes and pull requests:

- Frontend: Node 22, `npm ci`, `npm run check`.
- Backend: Python 3.11, PostgreSQL 16, Redis 7, install requirements, `python manage.py check --deploy`, migration drift check, Django tests, and `collectstatic`.
- Docker: build backend and frontend Dockerfiles.
- Security: `npm audit --audit-level=high` and `pip-audit`.

`.github/workflows/staging.yml` is manually triggered with `workflow_dispatch` and runs a staging smoke path with demo mode.

## Writing Tests

Backend tests live in `backend/flights/tests.py`. Add Django test cases there or split into additional modules when the suite grows.

Example:

```python
from django.test import TestCase
from flights.models import Aircraft


class AircraftTests(TestCase):
    def test_aircraft_creation(self):
        aircraft = Aircraft.objects.create(icao24="abc123", callsign="TEST123")
        self.assertEqual(aircraft.icao24, "abc123")
```

Frontend tests should prefer small pure helpers and behavior that does not require a browser. Use `*.test.ts` for pure utilities and `*.test.tsx` for React tests when component test utilities are added.

## Debugging

Backend debugger:

```bash
cd backend
python manage.py test --pdb --failfast
```

Verbose backend tests:

```bash
npm run backend:test -- --verbosity=2
```

Inspect SQL with Django's built-in shell and query logging rather than `shell_plus`, which is not part of the current requirements:

```bash
cd backend
python manage.py shell
```

## Common Issues

Import errors:

```bash
cd backend
python -m pip install -r requirements.txt
python manage.py test
```

Test database issues:

```bash
npm run backend:migrate
npm run backend:test
```

Frontend dependency issues:

```bash
npm --prefix frontend ci
npm run check
```

## Pre-PR Checklist

- [ ] `npm run check` passes.
- [ ] `npm run test:frontend` passes when frontend behavior changes.
- [ ] `npm run backend:check` passes.
- [ ] `npm run backend:check-deploy` is reviewed with production-like env values when deployment behavior changes.
- [ ] `npm run backend:test` passes.
- [ ] Migration drift check passes after model changes.
- [ ] Documentation is updated for user-facing behavior changes.

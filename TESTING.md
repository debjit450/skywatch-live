# Testing Guide

How to run tests for SkyWatch Live.

## Quick Start

```bash
# Run all tests
npm test

# Run frontend tests only
npm --prefix frontend run check  # includes typecheck, lint, build

# Run backend tests only
npm run backend:test
```

## Frontend Testing

### Typecheck

```bash
npm --prefix frontend run typecheck
```

Validates TypeScript code for type correctness without running tests.

### Linting

```bash
npm --prefix frontend run lint
```

Checks code style against ESLint configuration. See `frontend/eslint.config.js`.

### Format Check

```bash
npm --prefix frontend run format
```

Formats code with Prettier. Run this before committing to maintain consistency.

### Production Build

```bash
npm --prefix frontend run build
```

Creates an optimized production build. Issues here indicate build-time problems.

### Development Build

```bash
npm --prefix frontend run build:dev
```

Creates a development build with source maps for debugging.

### Full Frontend Check

```bash
npm --prefix frontend run check
```

Runs all frontend checks in sequence: typecheck → lint → production build

## Backend Testing

### Run All Tests

```bash
npm run backend:test
```

Runs Django test suite with verbose output.

### Run Specific Test Module

```bash
npm run backend:test -- flights.tests
```

### Run Specific Test Class

```bash
npm run backend:test -- flights.tests.FlightViewTests
```

### Run with Coverage

```bash
cd backend
python manage.py test --with-coverage
```

### Test Configuration

Backend tests use Django's test runner configured in `backend/skywatch/settings.py`:

- Uses in-memory SQLite database
- Disabled Celery tasks (runs synchronously)
- Logging suppressed for cleaner output
- Migrations applied automatically

### What Tests Exist

Check `backend/flights/tests.py` for test cases covering:
- Flight model creation and updates
- API endpoint functionality
- Data ingestion and normalization
- Anomaly detection logic
- Route reconstruction

## Code Quality Checks

### Full Project Check

```bash
npm run check
```

Runs frontend typecheck, lint, and build. Use before opening a PR.

### Backend Deployment Check

```bash
npm run backend:check-deploy
```

Runs Django deployment security check. Good for catching configuration issues before production.

### Backend System Check

```bash
npm run backend:check
```

Runs Django system checks to verify configuration and installed apps.

## Running Tests in CI/CD

GitHub Actions workflows run tests automatically on:
- Pull requests
- Pushes to main branch
- Scheduled daily checks

See `.github/workflows/ci.yml` for configuration.

### Manually Trigger CI

Push a commit to your branch or open a PR, and GitHub Actions will run tests automatically.

### Check CI Status

In a PR, scroll down to see status checks. Click "Details" to view full logs.

## Writing Tests

### Frontend

Tests can be added to component files or create `.test.ts`/`.test.tsx` files.

Example structure (if using a test framework - currently using typecheck/lint):

```typescript
// Example test structure (for future reference)
import { render, screen } from '@testing-library/react';
import { MyComponent } from './MyComponent';

describe('MyComponent', () => {
  it('renders correctly', () => {
    render(<MyComponent />);
    expect(screen.getByText('Expected Text')).toBeInTheDocument();
  });
});
```

### Backend

Add tests to `backend/flights/tests.py`:

```python
from django.test import TestCase
from flights.models import Aircraft, FlightState

class AircraftTests(TestCase):
    def setUp(self):
        self.aircraft = Aircraft.objects.create(
            icao24='abc123',
            callsign='TEST123'
        )
    
    def test_aircraft_creation(self):
        self.assertEqual(self.aircraft.icao24, 'abc123')
        self.assertEqual(self.aircraft.callsign, 'TEST123')
```

Run tests as described above.

## Debugging Tests

### Frontend Debug Mode

```bash
npm --prefix frontend run dev

# Then run tests separately with debugging
```

Check console/DevTools for errors.

### Backend Debug Mode

```bash
cd backend
python manage.py test --pdb --failfast
```

`--pdb` drops into Python debugger on test failure
`--failfast` stops at first failure

### Verbose Output

```bash
npm run backend:test -- --verbosity=2
```

## Common Test Issues

### Import Errors

**Problem**: `ModuleNotFoundError` in backend tests

**Solution**:
```bash
cd backend
pip install -r requirements.txt
python manage.py test
```

### Test Database Not Found

**Problem**: `psycopg2.OperationalError: FATAL: database does not exist`

**Solution**: Django creates temporary test database automatically. If issues persist:
```bash
npm run backend:migrate
npm run backend:test
```

### Async Tests Timing Out

**Problem**: Tests hang or timeout

**Solution**: Ensure async tasks are properly awaited/mocked in test setup.

### Celery Tasks Not Running

**Problem**: Background jobs not executing in tests

**Solution**: Backend test configuration uses `CELERY_TASK_ALWAYS_EAGER=True` to run tasks synchronously.

## Test Coverage

To measure test coverage:

```bash
cd backend
pip install coverage
coverage run --source='.' manage.py test
coverage report
coverage html  # Creates htmlcov/index.html
```

Current coverage targets:
- Backend: 70%+
- Frontend: Type checking via TypeScript
- Critical paths: 90%+

## Pre-Commit Checks

Before committing, run:

```bash
npm run check
npm run backend:check
```

This prevents pushing code that won't pass CI.

## Performance Testing

### Load Testing

For testing high traffic scenarios:

```bash
# Install load testing tool
npm install -g artillery

# Run load test against local backend
artillery run load-test.yml
```

### Database Query Performance

```bash
cd backend
python manage.py shell_plus --print-sql
# Then run queries to see SQL output
```

## Continuous Integration

GitHub Actions runs on:
- Every pull request
- Every push to main
- Scheduled daily (configurable)

To skip CI for a commit (not recommended):
```bash
git commit --no-verify
```

## Test Troubleshooting

For issues, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#backend-issues) or contact:

📧 debjitdey450@gmail.com

---

**Last Updated**: May 2024

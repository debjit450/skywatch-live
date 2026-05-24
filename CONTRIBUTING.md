# Contributing to SkyWatch Live

Last reviewed: 2026-05-24.

Contributions are welcome: bug reports, reproducible fixes, documentation updates, tests, and focused feature work.

## Getting Started

1. Fork the repository.
2. Clone your fork:

   ```bash
   git clone https://github.com/YOUR_USERNAME/skywatch-live.git
   ```

3. Create a feature branch:

   ```bash
   git checkout -b feature/your-change
   ```

4. Follow [docs/development.md](docs/development.md).

## Development Commands

```bash
npm run doctor
npm run startup
npm run dev-all
```

Useful commands:

| Command | Purpose |
| :--- | :--- |
| `npm run dev` | Start the frontend/TanStack Start dev server. |
| `npm run backend:dev` | Start Django. |
| `npm run dev-all` | Start frontend and Django together. |
| `npm run backend:celery` | Start the Celery worker. |
| `npm run backend:beat` | Start Celery Beat. |
| `npm run check` | Frontend typecheck, lint, and build. |
| `npm run backend:test` | Backend Django tests. |
| `npm test` | Frontend check plus backend tests. |

## Code Standards

- Keep changes focused on a single feature, fix, or documentation topic.
- Match the existing React/TypeScript and Django/Python style.
- Add or update tests for risky behavior changes.
- Update documentation when user-facing behavior, setup, routes, env vars, or deployment requirements change.
- Do not commit `.env`, `.env.local`, credentials, local databases, `node_modules`, `backend/venv`, generated model files, or build output.

## Reporting Issues

Bug reports should include:

- Clear description.
- Steps to reproduce.
- Expected and actual behavior.
- Environment details.
- Relevant logs, screenshots, or redacted config.

Use the GitHub issue templates where possible.

## Pull Requests

1. Keep PRs focused.
2. Explain the behavior change and why it is needed.
3. Link related issues.
4. Run the relevant checks:

   ```bash
   npm run check
   npm run backend:check
   npm run backend:test
   ```

5. Run migration drift checks after editing Django models:

   ```bash
   cd backend
   python manage.py makemigrations --check --dry-run
   ```

6. Update docs when needed.

## License

By contributing to SkyWatch Live, you agree that your contributions are licensed under the MIT License in [LICENSE](LICENSE).

Third-party dependency and data-source notes are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Questions

- Check existing [issues](https://github.com/debjit450/skywatch-live/issues).
- Read [SUPPORT.md](SUPPORT.md).
- Open a discussion for broad design or roadmap topics.

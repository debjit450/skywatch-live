# Support

Last reviewed: 2026-05-24.

This page explains where to get help with SkyWatch Live.

## Start with Documentation

- [README.md](README.md) - Main project guide and API reference.
- [QUICKSTART.md](QUICKSTART.md) - Fast local setup.
- [docs/development.md](docs/development.md) - Local development modes.
- [docs/architecture.md](docs/architecture.md) - Runtime architecture and data flow.
- [docs/data-sources.md](docs/data-sources.md) - Public feed contracts and reliability behavior.
- [docs/production.md](docs/production.md) - Production hardening.
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) - Common issues.
- [TESTING.md](TESTING.md) - Local and CI checks.

## GitHub Issues

Use GitHub Issues for:

- Bug reports.
- Feature requests.
- Documentation problems.
- Reproducible setup or deployment problems.

Search existing issues first to avoid duplicates.

## GitHub Discussions

Use GitHub Discussions for:

- General questions.
- Architecture discussion.
- Deployment design.
- Ideas that are not yet concrete bug reports or feature requests.

## Direct Contact

For direct support, contact:

`debjitdey450@gmail.com`

Use direct email for:

- Deployment assistance.
- Custom integration questions.
- Commercial support inquiries.
- Questions that include sensitive operational details.

Expected response time: 1-3 business days.

## Security Issues

Do not open public GitHub issues for vulnerabilities.

Use one of these channels:

1. Open a private GitHub security advisory.
2. Email `security@skywatch-live.dev`.
3. If the project security mailbox is unavailable, email `debjitdey450@gmail.com` with `[SECURITY]` in the subject.

See [SECURITY.md](SECURITY.md) for the full disclosure policy.

## Good Bug Reports Include

1. Clear problem description.
2. Steps to reproduce.
3. Expected behavior.
4. Actual behavior.
5. Environment details:
   - OS.
   - Browser.
   - Node.js version.
   - Python version.
   - Docker status.
   - Deployment mode.
6. Relevant logs and redacted configuration.

Example:

```text
Description: Dashboard becomes unresponsive after enabling all overlays.

Steps:
1. Start npm run dev-all.
2. Open http://localhost:8080.
3. Enable flights, weather, restrictions, satellites, airports, and labels.
4. Pan over a high-traffic region.

Expected: Smooth interaction.
Actual: Browser freezes for several seconds.

Environment:
- OS: Windows 11
- Browser: Chrome 125
- Node: 22.x
- Python: 3.11.x
- Docker: Desktop running
```

## Response Expectations

- Bug reports: acknowledged when maintainers have enough reproduction detail.
- Feature requests: reviewed as time allows.
- Pull requests: reviewed based on scope, risk, and maintainer availability.
- Direct support email: response within 1-3 business days.

## Community

- Star the project on GitHub if it is useful.
- Share deployment notes through issues or discussions.
- Contribute documentation and reproducible fixes.
- See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

# Security Policy

Last reviewed: 2026-05-24.

## Reporting a Vulnerability

Do not open public GitHub issues for security vulnerabilities.

Use one of these channels:

1. Open a private GitHub security advisory.
2. Email `security@skywatch-live.dev`.
3. If the project security mailbox is unavailable, email `debjitdey450@gmail.com` with `[SECURITY]` in the subject.

## Supported Versions

Security fixes target the current `main` branch and the latest published release tag, when release tags are available.

## Report Contents

Please include:

1. Vulnerability description.
2. Affected versions or commit range.
3. Steps to reproduce.
4. Impact and likely severity.
5. Suggested fix, if you have one.
6. Whether the issue is already public.

Do not include live secrets, production credentials, or sensitive third-party data in reports.

## Response Timeline

- Initial acknowledgment: within 48 hours when a maintainer is available.
- Triage: severity and affected surface are assessed after reproduction.
- Fix: confirmed issues are patched on a reasonable timeline based on severity.
- Disclosure: public disclosure is coordinated after a fix is available.

## Responsible Disclosure

Please:

- Give maintainers reasonable time to investigate and patch.
- Avoid public disclosure before a coordinated fix.
- Avoid accessing, modifying, deleting, or exfiltrating data beyond what is required to demonstrate impact.
- Use local or test deployments whenever possible.

## Production Security Checklist

When deploying SkyWatch Live:

1. Use HTTPS/WSS in production.
2. Set `DJANGO_DEBUG=False`.
3. Set `SKYWATCH_DEPLOYMENT_PROFILE=production`.
4. Use a strong `DJANGO_SECRET_KEY` of at least 50 characters.
5. Use exact `ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`, and `CORS_ALLOWED_ORIGINS`.
6. Set a non-default `DJANGO_ADMIN_URL_PATH`.
7. Use PostgreSQL and Redis with authentication and restricted network access.
8. Set `METRICS_USER` and `METRICS_PASSWORD`.
9. Enable secure cookies and HSTS where appropriate.
10. Keep dependencies updated and review Dependabot/security PRs.
11. Run `npm run backend:check-deploy` or `python manage.py check --deploy`.
12. Keep `.env`, `.env.local`, generated secrets, and credentials out of git.

## Known Security Boundaries

- Public aviation feeds can be unavailable, incomplete, stale, or rate-limited.
- Flight and satellite information from public sources is not a safety-of-life data source.
- Production WebSockets should use WSS through a reverse proxy.
- Image proxy hosts are restricted by `ALLOWED_AIRCRAFT_IMAGE_HOSTS`; keep that allow-list tight.
- Metrics can reveal operational details and must be protected outside local development.

## Credits

We appreciate responsible reports that improve SkyWatch Live's security posture.

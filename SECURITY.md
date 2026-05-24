# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in SkyWatch Live, please email security@skywatch-live.dev or open a private security advisory on GitHub.

**Please do not** open public GitHub issues for security vulnerabilities.

## Security Advisory Guidelines

When reporting a security issue, please include:

1. **Description** - What is the vulnerability?
2. **Affected Versions** - Which versions are affected?
3. **Steps to Reproduce** - How can the vulnerability be reproduced?
4. **Impact** - What is the security impact?
5. **Suggested Fix** - If you have a fix, please share it (but do not commit to the repository)

## Response Timeline

- **Initial Response**: We'll acknowledge receipt within 48 hours
- **Investigation**: We'll investigate and determine the severity
- **Fix Development**: We'll develop a patch for confirmed vulnerabilities
- **Public Disclosure**: We'll coordinate a public disclosure timeline with you

## Responsible Disclosure

We ask that you:
- Give us reasonable time to patch before public disclosure
- Don't publicly disclose the vulnerability until we've patched it
- Don't exploit vulnerabilities beyond what's necessary to demonstrate them

## Security Best Practices

When deploying SkyWatch Live:

1. **Use HTTPS in Production**
   - Set `DJANGO_SECURE_SSL_REDIRECT=True`
   - Configure proper TLS certificates
   - Enable HSTS headers

2. **Secure Secrets**
   - Change all `.env` default values
   - Use strong, randomly generated `DJANGO_SECRET_KEY`
   - Store credentials securely (AWS Secrets Manager, HashiCorp Vault, etc.)

3. **Database Security**
   - Use strong database credentials
   - Enable authentication for Redis
   - Restrict database network access

4. **Rate Limiting**
   - Use a reverse proxy (nginx, Caddy) for rate limiting
   - Monitor API usage for abuse

5. **Updates**
   - Keep dependencies updated regularly
   - Subscribe to security advisories for dependencies
   - Monitor our GitHub releases for security updates

6. **Monitoring**
   - Enable Sentry for error tracking
   - Configure Prometheus/Grafana monitoring
   - Set up alerts for anomalies

7. **Access Control**
   - Restrict admin access (`DJANGO_ADMIN_URL_PATH`)
   - Use strong authentication for admin users
   - Implement IP whitelisting where possible

## Known Limitations

- Public API endpoints are rate-limited but may be subject to availability
- Flight data is sourced from public aviation APIs - coverage is not guaranteed
- This is a surveillance tool; use responsibly and in compliance with local regulations
- WebSocket connections should be secured with WSS in production

## Questions?

For security-related questions, please contact the maintainers or open a GitHub discussion (not an issue).

## Credits

We appreciate responsible security researchers who help improve SkyWatch Live's security posture.

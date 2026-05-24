# Contributing to SkyWatch Live

We welcome contributions to SkyWatch Live! Whether it's bug reports, feature requests, documentation improvements, or code contributions, your help makes this project better.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/skywatch-live.git`
3. Create a feature branch: `git checkout -b feature/your-feature-name`
4. Follow the [development setup guide](docs/development.md)

## Development

### Setup
```bash
npm run dev-all          # Start all services
npm run backend:dev      # Start Django backend
npm run frontend dev     # Start React frontend
```

### Testing
```bash
npm test                 # Run all tests
npm run backend:test     # Run backend tests
npm run lint            # Run linter
npm run format          # Format code
```

### Code Standards
- Follow ESLint configuration for frontend (TypeScript/React)
- Follow PEP 8 for backend (Python)
- Add tests for new features
- Update documentation as needed
- Use meaningful commit messages

## Reporting Issues

When reporting bugs, please include:
- Description of the issue
- Steps to reproduce
- Expected vs actual behavior
- Environment (OS, Node version, Python version, etc.)
- Screenshots/logs if applicable

## Pull Request Process

1. Keep PRs focused on a single feature/fix
2. Write clear PR descriptions
3. Ensure tests pass: `npm test`
4. Keep commits clean and descriptive
5. Link related issues if applicable
6. Be responsive to code review feedback

## License

By contributing to SkyWatch Live, you agree that your contributions will be licensed under the MIT License.

## Questions?

- Check existing [issues](https://github.com/debjit450/skywatch-live/issues)
- Read [documentation](docs/)
- Open a discussion for feature requests

Thank you for contributing! 🚀

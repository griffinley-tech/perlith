# Contributing to Perlith

We welcome contributions. Here's how to get started.

## Getting Started

```bash
git clone https://github.com/griffinley-tech/perlith.git
cd perlith
npm install
npm test
```

## Contribution Workflow

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run tests (`npm test`)
5. Commit with a clear message
6. Open a pull request

## What We're Looking For

- Bug fixes with test cases
- Documentation improvements
- Performance improvements with benchmarks
- New retrieval strategies
- Integrations with other MCP-compatible tools

## Code Style

- CommonJS (`require`/`module.exports`) for core library
- ESM for MCP server and bin scripts
- No semicolons (we use ASI)
- Single quotes for strings
- Functions under 40 lines
- Files under 400 lines

## Reporting Bugs

Open an issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Node.js version and OS

## Security Issues

See [SECURITY.md](SECURITY.md) for responsible disclosure.

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.

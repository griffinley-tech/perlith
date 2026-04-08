# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Perlith, please report it responsibly.

**Email:** security@griffinley.com

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and provide a timeline for resolution.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Security Model

Perlith is a local-first memory system. All data stays on your filesystem. There are no network calls, no telemetry, no phone-home behavior.

- **No encryption at rest** in v0.1. Memory files are plaintext markdown. Protect them with filesystem permissions.
- **No authentication** in v0.1. The MCP server trusts all local connections.
- **Git-native audit trail.** Every memory write is committed to git. Run `git log` to see the full history of any agent's memory. Run `git diff` to see exactly what changed.

## Dependency Policy

We minimize dependencies. The core library requires only `js-yaml`, `simple-git`, and Node.js built-ins. The MCP server adds `@modelcontextprotocol/sdk` and `zod`.

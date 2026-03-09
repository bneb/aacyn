---
path: "**/crypto.*, **/auth.*, **/webhooks.*, **/license.*, **/heartbeat.*, **/rbac.*, **/sso.*"
---

# Security Rules

## Cryptographic Code (crypto.ts, libaacyn.c license functions)
- Ed25519 keys must never be logged or included in error messages.
- License salt must come from environment — crash on startup if `LICENSE_SALT` is unset in production.
- Signatures must be verified in constant time (Ed25519 verification already is).
- License expiry must be checked before every gated operation, not cached.

## Webhook Handlers
- aacyn is free and open source — no payment webhooks. The only webhook surface is the optional alerting webhook (Slack-compatible).

## Authentication & Authorization
- API keys must be stored hashed (SHA-256 minimum). Never store plaintext.
- Auth middleware must run on every non-health route.
- RBAC: verify role BEFORE executing the handler, not after.

## Data Handling
- Never log API keys.
- Sanitize error messages returned to clients — don't leak stack traces or internal paths.
- Cold storage archives contain raw telemetry — S3 buckets must have encryption at rest.

## Dependency Security
- Run `bun audit` (or equivalent) in CI. Block on critical/high CVEs.
- Pin dependency versions in `package.json`. Avoid `^` ranges for security-sensitive packages.
- Review new dependencies for supply chain risk before adding.

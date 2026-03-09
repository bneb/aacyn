---
path: ts/**/*.ts, ts/**/*.tsx
---

# TypeScript Rules (API + Web)

## Architecture
- **API server**: Elysia (Bun-native web framework) with Zod validation on all routes.
- **FFI bridge**: `native-store.ts` wraps libaacyn.so via `bun:ffi`. Fallback to `store.ts` (V8 Map) when .so unavailable.
- **License engine**: `heartbeat.ts` + `crypto.ts` — Ed25519 offline-first with optional heartbeat renewal.
- **Web app**: Next.js 16, React 19, Tailwind CSS v4.
- **Monorepo**: Bun workspaces — `apps/api`, `apps/web`, `packages/sdk`, `packages/ui`.

## Route Structure (server.ts)
10 route groups composed via Elysia `.use()`:
- `health.ts` — GET /health
- `ingest.ts` — POST /ingest/batch, POST /ingest/binary
- `query.ts` — POST /v1/query
- `trace.ts` — GET /query/trace/:traceId
- `otlp.ts` — POST /v1/traces (JSON + protobuf)
- `discovery.ts` — GET /v1/services, GET /v1/topology
- `dashboard.ts` — GET /dashboard (inline HTML template), GET /v1/dashboard (data API)
- `events.ts` — POST /v1/events (STUB — logs and acknowledges)
- Inline: GET /v1/license/status

## Quality Constraints
- Every route handler must have Zod validation on input. No `as` casts on request bodies.
- Store access must go through the typed `IStore` interface. Zero `(store as any)` casts.
- Every `catch` block must either log the error or propagate it. Zero empty `catch {}` blocks.
- Functions ≤ 32 lines. Break up long handlers with extracted functions.
- Nesting ≤ 3 levels. Use early returns and guard clauses.
- All external HTTP calls must have timeouts (`AbortSignal.timeout()`).
- Use `console.error` for errors, structured logging via pino once Sprint 2 is done.
- New API routes must be registered in `server.ts` and documented in `docs/api-reference.md`.

## Testing
- Test files live in `ts/apps/api/tests/` and `ts/apps/api/test/`.
- Use Bun's built-in test runner (`bun test`).
- Every route needs: happy path test, error path test, auth rejection test (once auth is added).
- Store-dependent code should accept an `IStore` instance for testability (dependency injection).
- Use `.env.test` for deterministic test values. Never call real external services in tests.

## Common Pitfalls
- Bun `bun:ffi` uses `Symbol.dispose` for cleanup — ensure `using` keyword or explicit `.close()`.
- Elysia `.derive()` creates per-request singletons — use it for store injection.
- Next.js 16 uses React 19 — no `forwardRef`, use `ref` prop directly.
- `@aacyn/sdk` exports types only — import with `import type` to avoid runtime imports.

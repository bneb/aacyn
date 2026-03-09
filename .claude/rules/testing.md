---
path: "**/*.test.*, **/*.spec.*, **/tests/**"
---

# Testing Rules

## Coverage Target: ≥ 95% Line Coverage

Every changed file must maintain ≥ 95% line coverage. When coverage drops, add tests before the commit.

## Test Structure

### TypeScript (Bun test)
- Test files: `tests/*.test.ts` (integration), `test/*.test.ts` (unit).
- Use `describe`/`it` blocks. Each `it` should test one behavior.
- Use `beforeAll`/`afterAll` for store setup/teardown.
- Inject dependencies — don't rely on global singletons.
- Mock external services (S3, Resend, etc.) using Bun's mock or simple stub objects.

### C (test_ouroboros.c)
- Test one function per test case.
- Assert with `assert(condition)` from `<assert.h>`.
- Test edge cases: empty store, full store, wraparound boundary, NULL inputs, zero capacity.
- Run under ASan/UBSan to catch memory errors.

## Mutation Testing

After writing tests, verify they catch faults:
- **TypeScript**: Use `stryker-js` with the Bun test runner. Configure mutation operators: `equality`, `logical`, `conditional`, `string`, `array`, `block`.
- **C**: Manual mutation — introduce a fault (inverted condition, off-by-one, null return), verify a test fails. Remove the fault.

Target: **0 surviving mutants** on all changed code.

## Test Naming Convention
```
describe('route: /v1/ingest/binary', () => {
  it('accepts valid FlatBuffer payload', ...)
  it('rejects payload under 16 bytes', ...)
  it('rejects payload with wrong magic bytes', ...)
  it('handles store-at-capacity rejection', ...)
})
```

## What Must Be Tested
- Happy path (valid input → expected output)
- Error path (invalid input → appropriate error)
- Boundary conditions (empty, full, exactly-at-limit, one-over-limit)
- Concurrency (if applicable — parallel ingestion, ring buffer races)
- Recovery (crash recovery, reconnection, timeout)

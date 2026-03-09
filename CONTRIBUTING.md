# Contributing to aacyn

## Quickstart

- `git clone git@github.com:your/aacyn.git && cd aacyn`
- `cd ts && bun install` — install TypeScript dependencies
- `cd native && make` — build libaacyn.so (macOS/Linux, auto-detects SIMD)
- `cd ts && bun test` — run all TypeScript tests
- `cd native && make test` — run all C tests (test_ouroboros)

Done. You can now run the API (`just dev-api`) or the full stack (`just dev`).

## Architecture

Three-language observability pipeline: eBPF probes in the kernel push connection events through a shared ring buffer into a user-space columnar store (C, mmap'd, SIMD-accelerated). The store is consumed by a TypeScript/Bun API (Elysia) that serves a Next.js dashboard, a Grafana data source plugin (Go), and optional forwarders (Datadog, etc.). Architectural decisions are documented in `docs/adr/` (5 records covering the columnar store, mmap, SIMD, runtime platform, and serialization format).

## Development Loop

**TypeScript:** `cd ts && bun install && bun test` — runs all tests (Bun test runner). Run `cd ts/apps/api && bun test --watch` for TDD.

**C:** `cd native && make && make test` — compiles libaacyn with platform-appropriate SIMD (NEON on ARM, AVX-512 on x86). Additional builds:
- `make sanitize` — ASan/UBSan for memory error detection
- `EBPF=1 make` — Linux only, builds with libbpf and compiles eBPF probes

**Full stack:**
- `just dev-api` — Elysia API server on port 3001
- `just dev-web` — Next.js dashboard on port 3000
- `just dev` — both in parallel

## Quality Gates (must pass before commit)

| Command | Expectation |
|---------|-------------|
| `cd ts && bun run lint` | 0 errors, 0 warnings (ESLint + Prettier) |
| `cd ts && bun run typecheck` | 0 errors (tsc --noEmit, strict mode) |
| `cd ts && bun test` | All tests pass |
| `cd native && make test` | All C tests pass |
| `cd native && make sanitize` | No memory errors (Linux recommended, macOS partial) |

Additional automated gates enforced by `.claude/hooks/`: function length <= 32 lines, nesting depth <= 3 levels, zero empty catch blocks, no `as any` casts on the store interface, mutation test pass on changed code.

## How to Add a New eBPF Hook Point

1. Add the tracepoint or kprobe in `native/aacyn_probes.bpf.c` — follow the existing pattern: SEC definition, BPF_CORE_READ for field access, bpf_ringbuf_reserve + bpf_ringbuf_submit, ring buffer reservation NULL check.
2. Define the event struct at the top of `aacyn_probes.bpf.c` — layout must match what the user-space consumer expects (16-byte aligned).
3. Add a ring buffer consumer case in `libaacyn.c`, function `ebpf_event_handler()` — one switch case per event type, parse the struct, write to the columnar store.
4. Update the event type enum in both the BPF C file and `libaacyn.c` so producer and consumer agree on type IDs.
5. Test on a Linux VM: `cd native && EBPF=1 make && sudo ./test_ouroboros`.

## How to Add a New Forwarder

1. Create `ts/apps/api/src/lib/forwarders/yourbackend.ts` — implement the `Forwarder` interface exported from `ts/apps/api/src/lib/forwarder.ts` (your `send(batch)` method receives a `ForwardBatch` with pre-aggregated metrics and topology edges).
2. Import and register the forwarder in `ts/apps/api/src/server.ts` — call `registerForwarder()` during server startup.
3. Add config keys to `aacyn.toml` (or env vars) — document in `charts/aacyn/values.yaml` if helm-managed.
4. Test against a local instance of the target backend.

## How to Run Benchmarks

`cd benchmarks && bun run scan_benchmark.ts` (requires native engine built at `build/libaacyn.dylib` or `build/libaacyn.so`).

## Code Style

Match what you see in the file you are editing.

- **C:** Linux kernel style — 8-character tabs, 80-column lines, lowercase snake_case functions, pointer star attached to the name (`char *s` not `char* s`).
- **TypeScript:** Prettier defaults via ESLint. No semicolons (enforced). Arrow functions. PascalCase types and classes, camelCase everything else.
- **eBPF:** Same as C, plus: all loops must have compile-time-constant bounds, all pointer derefs through BPF_CORE_READ, stack <= 512 bytes.
- **Helm:** 2-space indentation, `{{ .Values.path | quote }}` for strings.

## License

Apache 2.0. By contributing you agree that your contributions are licensed under the Apache 2.0 license. See `LICENSE` in the project root.

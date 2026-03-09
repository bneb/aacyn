# ADR 005: Hand-rolled FlatBuffer binary protocol vs Protobuf vs JSON

**Status:** Accepted (implemented v0.1.0)
**Last updated:** 2026-03

## Context

The binary ingest endpoint (`POST /v1/ingest/binary`) receives eBPF-derived telemetry from agents deployed across the cluster. Each event carries: `timestamp` (uint64), `duration_ms` (float32), `status_code` (uint16), and implicit service identity derived from the connection tuple. The target throughput is 5 million events/second per node in burst, sustained at 1-2 M/s under normal load.

The protocol must be parseable in C without any library dependencies. The native columnar store (`libaacyn.c`) has exactly zero external runtime deps by design — it uses only POSIX syscalls (`mmap`, `write`, `close`) and the C standard library. Adding a protocol library would break this property.

The TypeScript side (Bun API) must also encode and decode the same wire format for test tooling, agent injection, and the debug endpoint.

## Options Considered

### 1. JSON

Each event serialized as a JSON object:

```json
{"ts":1700000000000000000,"dur":14.5,"err":0,"svc":"nginx","ip":2886729748}
```

**Overhead:** ~120 bytes per event after keys, braces, commas, quotes. At 5 M/s that is 600 MB/s of JSON on the wire. But the real cost is parsing: a JSON library must tokenize, validate UTF-8, convert string keys to field lookups, and allocate heap objects for each value. On a single core this caps out at roughly 200-300 MB/s for SIMD-accelerated parsers like simdjson. The ingest path would require 2-3 dedicated cores just for deserialization, competing with the eBPF ring buffer consumer and the columnar store. Non-starter.

**Verdict:** Rejected — throughput wall at 1/5 of target.

### 2. Protobuf (nanopb)

nanopb compiles `.proto` schemas into C structs and a bytecode decoder (~8 KB footprint). Wire format uses varints for integers, so typical event sizes are 20-40 bytes. Decoding is allocation-free for the struct itself (stack-allocated) but nested messages and repeated fields require pre-allocated buffers or callbacks.

The practical cost: nanopb requires a schema compiler (`nanopb_generator.py`), a build-system step to regenerate C code from `.proto` changes, and the decoder runtime linked into the binary. The schema is small (one table, one nested struct) but the toolchain dependency is real — every developer and CI runner needs protoc + the nanopb plugin. Upstream protobuf changes (wire format quirks like group deprecation, `google.protobuf.Timestamp`) can trigger rebuilds for zero benefit. For five fields that never change shape, a full schema compiler is overkill.

The varint encoding also prevents fixed offsets: fields are not at known byte positions, so the "parse by pointer cast" trick is impossible. Every decode requires walking the varint stream.

**Verdict:** Rejected — solid technology, wrong fit for a fixed-schema 5-field struct.

### 3. FlatBuffers (flatcc)

FlatBuffers solves the parsing problem elegantly: the wire format is the in-memory layout. A `flatcc`-generated struct can be cast directly from the buffer pointer with no allocation or copying. `flatcc` generates ~30,000 lines of C for even a small schema (vtable codegen, builder API, verifier, reflection support). The build system must run `flatcc -a telemetry.fbs` and compile the output.

For our use case — five scalar fields — the FlatBuffers schema is 10 lines but the generated code is three orders of magnitude larger. The builder API also adds a write-side dependency: the TypeScript encoder must use `flatbuffers` (npm) and the C decoder must link `flatcc` runtime. Maintenance burden outweighs benefit for a struct that fits in a `_Static_assert`.

**Verdict:** Rejected — correct abstraction, disproportionate machinery.

### 4. Hand-rolled 16-byte fixed-width struct

Each event is exactly 16 bytes on the wire:

| Offset | Size | Field |
|--------|------|-------|
| 0 | 8 | `uint64_t timestamp` |
| 8 | 4 | `float duration_ms` |
| 12 | 2 | `uint16_t status_code` |
| 14 | 2 | `uint16_t _padding` |

The events are wrapped in a FlatBuffers-compatible table envelope: 4-byte root offset, a vtable with two field entries (trace_id string, events vector), then a 4-byte vector length followed by N inline 16-byte structs. This is not a custom format — it is a subset of the FlatBuffers specification that happens to require zero generated code.

The C decoder (`aacyn_store_ingest_flatbuf` at `native/libaacyn.c` lines 1001-1094) reads the root offset, walks the vtable to locate the events vector, checks bounds on every dereference, then casts the vector data to `flatbuf_event_t *` and memcpy's columns into the mmap'd SoA store. Zero allocations on the hot path. The function returns 0 for any malformed input — every `memcpy` is preceded by a bounds check against `buf_len`.

The TypeScript encoder/decoder (`native-store.ts` `ingestBinary()` at line 459) passes the raw `ArrayBuffer` to C via `bun:ffi` with zero JS-side processing. Test tooling builds buffers using `DataView` writes at known offsets.

**Bandwidth:** 16 bytes per event * 5 M/s = 80 MB/s input. The C function is memcpy-bound, not CPU-bound — 80 MB/s is well within L3 cache bandwidth (typical modern Xeon: 40-80 GB/s). The columnar shred (line 1078-1082) reads each 16-byte struct sequentially on a single thread, which prefetches perfectly.

**Schema stability:** The event has not grown since the initial implementation (first commit 2026-03-09). The five fields capture everything the eBPF probes produce (kernel-side struct `ebpf_network_event_t` at line 1105 is 46 bytes — it includes PID, comm, IPs, port, and bytes, but those are consumed by the C event handler before ingestion, not transmitted over the wire). If a new field is needed, the struct size changes and both sides must be deployed together — acceptable in a single-binary appliance.

**Verdict:** Accepted.

## Consequences

- **No wire versioning.** Protocol version is negotiated at startup via the health endpoint (`/health` returns the binary protocol version). Mismatched agents are rejected at ingest time. In practice, agents and the API are deployed as a single appliance image, so version skew cannot occur without a deliberate rolling update.

- **Not extensible.** Adding a field requires changing the struct size. Mitigation: the event schema is stable by nature — eBPF hook points (`tcp_sendmsg`, `connect`) produce a bounded set of fields. If a new probe (e.g., TCP retransmit) adds data, it is accumulated in the C event handler's topology edge struct, not the wire format.

- **TypeScript must manually lay out bytes.** The test harness and any non-C encoder write the FlatBuffers table by hand using `DataView.setUint32(...)` at fixed offsets. This is ~30 lines of code and has never needed maintenance.

## Fuzzing

The FlatBuffer parser handles untrusted network input. A dedicated FlatBuffer fuzz harness is planned. The existing fuzzer at `native/fuzz_ouroboros.c` tests the core columnar store API under random inputs. Every bounds check in the ingest path (lines 1009, 1020, 1026, 1032, 1044, 1050) must reject invalid input with return 0. No malloc, no calloc, no free is called on the decode path (the heap allocation at line 1063 is for batch insertion, not parsing — the parser itself is allocation-free).

## References

- Binary ingest implementation: `native/libaacyn.c` lines 962-1094 (FlatBuffers reader + EventStruct typedef)
- EventStruct definition: `native/libaacyn.c` lines 983-990 (`flatbuf_event_t`, 16 bytes, `_Static_assert`)
- TypeScript FFI bridge: `ts/apps/api/src/lib/native-store.ts` lines 459-468 (`ingestBinary()`)
- Columnar batch insert: `native/libaacyn.c` lines 1001-1094 (full ingest pipeline)
- Store header magic (`AACYN_MAGIC = 0x4141434E`): `native/libaacyn.c` line 52
- eBPF source event struct (46 bytes, kernel side): `native/libaacyn.c` lines 1105-1115
- Fuzzer harness: `native/fuzz_ouroboros.c` (store API fuzzing)

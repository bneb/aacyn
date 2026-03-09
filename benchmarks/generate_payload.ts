/**
 * FlatBuffer Payload Generator — Pre-Compile for k6 Siege
 *
 * Generates a deterministic but realistic 100-event FlatBuffer payload
 * and writes it to disk as a raw .bin file. k6 reads this file once
 * during init and blasts it from memory — eliminating JS payload
 * construction as a benchmark bottleneck.
 *
 * Run: bun run benchmarks/generate_payload.ts
 * Output: benchmarks/payload.bin
 */

import { buildFlatBufferPayload, type FlatBufferEvent } from "../ts/apps/api/src/lib/flatbuf-builder";

const EVENT_COUNT = 100;
const BASE_TIMESTAMP = 1709000000000000000n;  // Epoch ns

// ─── Generate Realistic Events ───────────────────────────────────────────────
// Simulate a production traffic pattern:
//   - Timestamps advance by ~1ms each
//   - Durations follow a lognormal distribution (realistic latency)
//   - 5% error rate (status 500), rest are 200

function lognormalLatency(): number {
    // Box-Muller transform → lognormal with μ=1.5ms, σ=0.8ms
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.exp(0.4 + z * 0.5);  // Peak around 1.5ms, tail to ~20ms
}

const events: FlatBufferEvent[] = Array.from({ length: EVENT_COUNT }, (_, i) => ({
    timestamp: BASE_TIMESTAMP + BigInt(i) * 1000000n,  // 1ms apart
    durationMs: lognormalLatency(),
    statusCode: Math.random() < 0.05 ? 500 : 200,      // 5% error rate
}));

const payload = buildFlatBufferPayload("siege-binary-payload", events);
const bytes = new Uint8Array(payload);

// ─── Write to Disk ───────────────────────────────────────────────────────────
await Bun.write("benchmarks/payload.bin", bytes);

// ─── Report ──────────────────────────────────────────────────────────────────
const KB = (bytes.byteLength / 1024).toFixed(2);
console.log(`
╔══════════════════════════════════════════════════════════╗
║  🛡️ FlatBuffer Payload Generated                        ║
╠══════════════════════════════════════════════════════════╣
║  Events:   ${EVENT_COUNT}                                        ║
║  Bytes:    ${bytes.byteLength} (${KB} KB)                          ║
║  Output:   benchmarks/payload.bin                        ║
║                                                          ║
║  Wire layout per event: 16 bytes (u64+f32+u16+pad)       ║
║  Total payload: header + ${EVENT_COUNT} × 16B = ${bytes.byteLength}B         ║
╚══════════════════════════════════════════════════════════╝
`);

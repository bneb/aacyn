// ─────────────────────────────────────────────────────────────────────────────
// aacyn Binary Siege Benchmark — k6 FlatBuffer Zero-Parse Pipeline
//
// Tests the mathematical superiority of Path B (binary) over Path A (JSON).
//
// Architecture:
//   ┌────────────┐         ┌─────────────────┐         ┌──────────────┐
//   │    k6 VU   │ ──────► │ /ingest/binary  │ ──────► │  libaacyn.c  │
//   │ (raw .bin) │  POST   │  (zero parse)   │  FFI ptr│  (mmap SoA)  │
//   └────────────┘  octet  └─────────────────┘         └──────────────┘
//
// Pre-requisites:
//   1. bun run benchmarks/generate_payload.ts  (creates payload.bin)
//   2. bun run ts/apps/api/src/index.ts        (starts API on :3001)
//   3. k6 run benchmarks/k6_binary.js          (this file)
//
// Or: just benchmark-binary
// ─────────────────────────────────────────────────────────────────────────────

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// ─── Custom Metrics ──────────────────────────────────────────────────────────
const ingestLatency = new Trend('aacyn_binary_ingest_latency', true);
const eventsIngested = new Counter('aacyn_binary_events_ingested');
const binaryErrorRate = new Counter('aacyn_binary_errors');

// ─── Pre-Load Binary Payload (ONCE — in k6 init phase) ──────────────────────
// This is the critical optimization: the payload is read from disk into
// memory exactly once. Each VU iteration sends this same byte array.
// No JS-side construction, no serialization, no GC pressure in k6.
const payload = open('./payload.bin', 'b');

// ─── Load Configuration ─────────────────────────────────────────────────────
//
// Staging Ramp:
//   0s  → 10s:  Ramp to 500 VUs   (TCP warm-up, connection pool fill)
//   10s → 40s:  Hold at 500 VUs   (sustained siege — this is the real test)
//   40s → 50s:  Ramp to 0 VUs     (graceful drain, observe tail latency)
//
// Each request sends 100 events via binary FlatBuffer.
// At 500 VUs with ~3000 req/s, that's ~300,000 events/second.

export const options = {
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
    stages: [
        { duration: '10s', target: 500 },
        { duration: '30s', target: 500 },
        { duration: '10s', target: 0 },
    ],
    thresholds: {
        'http_req_duration': [
            'p(95)<15',   // p95 under 15ms
            'p(99)<25',   // p99 under 25ms
        ],
        'aacyn_binary_errors': ['count==0'],
    },
};

// ─── Virtual User Loop ──────────────────────────────────────────────────────
export default function () {
    const params = {
        headers: {
            'Content-Type': 'application/octet-stream',
        },
    };

    const res = http.post('http://localhost:3001/ingest/binary', payload, params);

    // Track custom metrics
    ingestLatency.add(res.timings.duration);

    const passed = check(res, {
        'status is 202': (r) => r.status === 202,
        'accepted > 0': (r) => {
            try {
                const body = JSON.parse(r.body);
                return body.accepted > 0;
            } catch {
                return false;
            }
        },
        'mode is binary': (r) => {
            try {
                const body = JSON.parse(r.body);
                return body.mode === 'binary';
            } catch {
                return false;
            }
        },
    });

    if (passed) {
        eventsIngested.add(100);  // 100 events per payload
    } else {
        binaryErrorRate.add(1);
    }
}

// ─── Summary Report ─────────────────────────────────────────────────────────
export function handleSummary(data) {
    const dur = data.metrics.http_req_duration ? data.metrics.http_req_duration.values : null;
    const totalReqs = data.metrics.http_reqs ? data.metrics.http_reqs.values.count : 0;
    const totalEvents = totalReqs * 100;
    const durationSec = 50;
    const rps = Math.round(totalReqs / durationSec);
    const eps = Math.round(totalEvents / durationSec);
    const avgLatency = dur ? dur.avg.toFixed(2) : '?';
    const p95Latency = dur ? dur['p(95)'].toFixed(2) : '?';
    const p99Latency = dur ? dur['p(99)'] : undefined;
    const maxLatency = dur ? dur.max.toFixed(2) : '?';
    const errors = data.metrics.aacyn_binary_errors ? data.metrics.aacyn_binary_errors.values.count : 0;

    const report = `
╔══════════════════════════════════════════════════════════════════════╗
║              🛡️ SOVEREIGN BINARY SIEGE REPORT                      ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  Total Requests:       ${String(totalReqs).padStart(12)}     (${rps.toLocaleString()} req/s)     ║
║  Events Ingested:    ${String(totalEvents).padStart(14)}     (${eps.toLocaleString()} evt/s)     ║
║                                                                      ║
║  Latency (ms):                                                       ║
║    avg:                   ${String(avgLatency).padEnd(21)}║
║    p95:                  ${String(p95Latency).padEnd(22)}║
║    p99:               ${String(p99Latency !== undefined ? p99Latency.toFixed(2) : 'N/A').padEnd(25)}║
║    max:                  ${String(maxLatency).padEnd(22)}║
║                                                                      ║
║  Thresholds:                                                         ║
║    p95 < 15ms:       ${p95Latency <= 15 ? '✅ PASS' : '❌ FAIL'}                                ║
║    p99 < 25ms:       ${(p99Latency !== undefined && p99Latency <= 25) ? '✅ PASS' : '❌ FAIL'}                                ║
║    errors == 0:      ${errors === 0 ? '✅ PASS' : '❌ FAIL'}                                ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝
`;

    return {
        stdout: report,
    };
}

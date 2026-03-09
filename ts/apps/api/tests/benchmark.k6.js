// ─────────────────────────────────────────────────────────────────────────────
// aacyn Siege Benchmark — k6 Load Test Suite
//
// Proves the Elysia/Bun ingestion pipeline handles enterprise scale.
// 500 virtual users × 100 RED metrics/request × 30 seconds sustained.
//
// Acceptance thresholds (zero-tolerance):
//   - HTTP error rate:  exactly 0.00%
//   - p95 latency:      strictly < 10ms
//   - p99 latency:      strictly < 15ms
//
// Usage:
//   k6 run ts/apps/api/tests/benchmark.k6.js
//
// Prerequisites:
//   - Elysia API running: cd ts/apps/api && bun run dev
// ─────────────────────────────────────────────────────────────────────────────

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

// ─── Custom Metrics (for the VC deck) ────────────────────────────────────────
const ingestLatency = new Trend('ingest_duration_ms');
const errorRate = new Rate('error_rate');
const eventsIngested = new Counter('events_ingested_total');
const requestsCompleted = new Counter('requests_completed_total');

// ─── Load Profile ────────────────────────────────────────────────────────────
export const options = {
    stages: [
        { duration: '10s', target: 500 },  // Ramp: 0 → 500 VUs over 10s
        { duration: '30s', target: 500 },  // Hold: sustained 500 VU siege for 30s
        { duration: '10s', target: 0 },    // Cool: ramp down gracefully
    ],

    thresholds: {
        // Sovereign engineering standards — non-negotiable
        'error_rate': ['rate==0'],            // Zero dropped telemetry
        'http_req_duration': ['p(95)<10', 'p(99)<15'], // Sub-15ms p99, sub-10ms p95
        'http_req_failed': ['rate<0.001'],          // Built-in k6 failure rate
    },

    // Connection tuning to prevent local port exhaustion
    noConnectionReuse: false,
    userAgent: 'aacyn-siege/1.0.0',
};

// ─── Entropy Constants ───────────────────────────────────────────────────────
const BATCH_SIZE = 100;  // 100 RED metric events per request
const SERVICE_NAMES = [
    'api-gateway',
    'auth-service',
    'payment-processor',
    'db-cluster',
    'notification-worker',
    'user-service',
    'cache-layer',
    'search-indexer',
];

const API_BASE = __ENV.API_URL || 'http://localhost:3001';

// ─── Payload Generator ──────────────────────────────────────────────────────
// Each VU generates a unique, high-cardinality batch every iteration.
// No two requests share the same traceId or timestamp — prevents backend
// caching from inflating throughput numbers.
function generateBatch(size) {
    const events = [];
    const now = Date.now();

    for (let i = 0; i < size; i++) {
        events.push({
            traceId: `trace-${randomHex(12)}-${randomHex(4)}`,
            service: SERVICE_NAMES[i % SERVICE_NAMES.length],
            durationMs: Math.random() * 500,         // 0–500ms realistic range
            isError: Math.random() > 0.98,         // ~2% error rate
            timestamp: now - Math.floor(Math.random() * 60000), // Jittered within last 60s
        });
    }

    return JSON.stringify({ events });
}

// Fast hex string generator (higher entropy than Math.random().toString(36))
function randomHex(length) {
    const chars = '0123456789abcdef';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars[Math.floor(Math.random() * 16)];
    }
    return result;
}

// ─── Main Test Function ─────────────────────────────────────────────────────
// Executed by every VU on every iteration of the load stages.
export default function () {
    const payload = generateBatch(BATCH_SIZE);

    const params = {
        headers: {
            'Content-Type': 'application/json',
            'X-Sovereign-Load-Test': 'true',
            'X-VU-ID': `${__VU}`,
            'X-Iter': `${__ITER}`,
        },
    };

    const res = http.post(`${API_BASE}/ingest/batch`, payload, params);

    // ─── Assertions ──────────────────────────────────────────────────────
    const passed = check(res, {
        'status is 202 Accepted': (r) => r.status === 202,
        'body has accepted count': (r) => {
            try {
                const body = JSON.parse(r.body);
                return body.accepted === BATCH_SIZE;
            } catch {
                return false;
            }
        },
        'body has timestamp': (r) => {
            try {
                const body = JSON.parse(r.body);
                return body.timestamp > 0;
            } catch {
                return false;
            }
        },
    });

    // ─── Metric Recording ────────────────────────────────────────────────
    errorRate.add(!passed);
    ingestLatency.add(res.timings.duration);
    requestsCompleted.add(1);

    if (passed) {
        eventsIngested.add(BATCH_SIZE);
    }

    // Minimal sleep to maximize throughput without exhausting local ports.
    // 10ms is enough to let the OS recycle TIME_WAIT sockets.
    sleep(0.01);
}

// ─── Lifecycle Hooks ────────────────────────────────────────────────────────
export function handleSummary(data) {
    // Print a clean summary for the VC deck
    const p95 = data.metrics.http_req_duration?.values?.['p(95)']?.toFixed(2);
    const p99 = data.metrics.http_req_duration?.values?.['p(99)']?.toFixed(2);
    const max = data.metrics.http_req_duration?.values?.max?.toFixed(2);
    const avg = data.metrics.http_req_duration?.values?.avg?.toFixed(2);
    const reqs = data.metrics.http_reqs?.values?.count;
    const evts = data.metrics.events_ingested_total?.values?.count;

    const report = `
╔══════════════════════════════════════════════════════════════════════╗
║                   🛡️ SOVEREIGN SIEGE REPORT                        ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  Total Requests:     ${String(reqs).padStart(10)}                    ║
║  Events Ingested:    ${String(evts).padStart(10)}                    ║
║                                                                      ║
║  Latency (ms):                                                       ║
║    avg:              ${String(avg).padStart(10)}                     ║
║    p95:              ${String(p95).padStart(10)}                     ║
║    p99:              ${String(p99).padStart(10)}                     ║
║    max:              ${String(max).padStart(10)}                     ║
║                                                                      ║
║  Thresholds:                                                         ║
║    p95 < 10ms:       ${p95 < 10 ? '✅ PASS' : '❌ FAIL'}            ║
║    p99 < 15ms:       ${p99 < 15 ? '✅ PASS' : '❌ FAIL'}            ║
║    error rate == 0:  ${data.metrics.error_rate?.values?.rate === 0 ? '✅ PASS' : '❌ FAIL'}  ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝
`;

    console.log(report);

    return {
        stdout: report,
    };
}

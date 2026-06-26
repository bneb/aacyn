/**
 * Demo Data — Pre-loaded sample topology for cold-start dashboard UX.
 *
 * When the store is empty (no eBPF events yet), the dashboard renders
 * this sample topology so evaluators see a live-looking graph immediately.
 * A banner indicates the data is synthetic and links to deployment docs.
 */

import type { DashboardDataResponse } from "../routes/dashboard";

function detectSimdPath(): "AVX-512" | "NEON" | "scalar" {
    if (process.arch === "arm64") return "NEON";
    if (process.arch === "x64") return "AVX-512";
    return "scalar";
}

export const DEMO_DASHBOARD: DashboardDataResponse = {
    edges: [
        {
            source: "nginx",
            target: "auth-service",
            latency_us: 4200,
            protocol: "http",
            hit_count: 15234,
            dest_ip: "10.0.1.10",
            dest_port: 3000,
            bytes_transferred: 20480000,
            error_count: 12,
                        source_pod_name: "nginx-7d4f8c9b-xk2j",
            source_pod_namespace: "default",
            source_deployment: "nginx",
            target_pod_name: "auth-5c8d4f6b-9wm3",
            target_pod_namespace: "services",
            target_deployment: "auth-service",
        },
        {
            source: "auth-service",
            target: "payment-api",
            latency_us: 8500,
            protocol: "http",
            hit_count: 8921,
            dest_ip: "10.0.2.15",
            dest_port: 4000,
            bytes_transferred: 12400000,
            error_count: 3,
                        source_pod_name: "auth-5c8d4f6b-9wm3",
            source_pod_namespace: "services",
            source_deployment: "auth-service",
            target_pod_name: "payment-3a1b7c9d-4fk2",
            target_pod_namespace: "services",
            target_deployment: "payment-api",
        },
        {
            source: "payment-api",
            target: "postgres",
            latency_us: 3200,
            protocol: "tcp",
            hit_count: 8921,
            dest_ip: "10.0.3.5",
            dest_port: 5432,
            bytes_transferred: 3100000,
            error_count: 0,
                        source_pod_name: "payment-3a1b7c9d-4fk2",
            source_pod_namespace: "services",
            source_deployment: "payment-api",
            target_pod_name: "postgres-0",
            target_pod_namespace: "data",
            target_deployment: "postgres",
        },
        {
            source: "nginx",
            target: "user-service",
            latency_us: 6100,
            protocol: "grpc",
            hit_count: 4520,
            dest_ip: "10.0.1.20",
            dest_port: 50051,
            bytes_transferred: 8900000,
            error_count: 47,
            source_pod_name: "nginx-7d4f8c9b-xk2j",
            source_pod_namespace: "default",
            source_deployment: "nginx",
            target_pod_name: "user-8f2a4c1d-7hn1",
            target_pod_namespace: "services",
            target_deployment: "user-service",
        },
        {
            source: "user-service",
            target: "redis-cache",
            latency_us: 1200,
            protocol: "tcp",
            hit_count: 12450,
            dest_ip: "10.0.4.3",
            dest_port: 6379,
            bytes_transferred: 5600000,
            error_count: 0,
                        source_pod_name: "user-8f2a4c1d-7hn1",
            source_pod_namespace: "services",
            source_deployment: "user-service",
            target_pod_name: "redis-0",
            target_pod_namespace: "data",
            target_deployment: "redis-cache",
        },
    ],
    total_ebpf_events: 49846,
    drops: { standard: 0, critical: 0 },
    golden_signals: [
        {
            service: "auth-service",
            rate_rps: 84.6,
            error_pct: 0.08,
            avg_latency_ms: 4.2,
            p50_ms: 3.1,
            p95_ms: 12.4,
            p99_ms: 34.7,
            throughput_kbps: 112.3,
            sparkline: [78, 82, 85, 80, 88, 84, 86, 83, 90, 85],
        },
        {
            service: "payment-api",
            rate_rps: 49.6,
            error_pct: 0.03,
            avg_latency_ms: 8.5,
            p50_ms: 6.2,
            p95_ms: 22.1,
            p99_ms: 55.8,
            throughput_kbps: 68.9,
            sparkline: [52, 48, 50, 49, 51, 47, 50, 48, 52, 49],
        },
        {
            service: "postgres",
            rate_rps: 49.6,
            error_pct: 0,
            avg_latency_ms: 3.2,
            p50_ms: 2.1,
            p95_ms: 8.4,
            p99_ms: 18.2,
            throughput_kbps: 17.2,
            sparkline: [48, 50, 49, 51, 48, 50, 49, 50, 48, 50],
        },
        {
            service: "user-service",
            rate_rps: 25.1,
            error_pct: 1.04,
            avg_latency_ms: 6.1,
            p50_ms: 4.8,
            p95_ms: 18.3,
            p99_ms: 42.1,
            throughput_kbps: 49.4,
            sparkline: [28, 24, 26, 23, 27, 25, 22, 26, 24, 25],
        },
        {
            service: "redis-cache",
            rate_rps: 69.2,
            error_pct: 0,
            avg_latency_ms: 1.2,
            p50_ms: 0.8,
            p95_ms: 3.2,
            p99_ms: 7.5,
            throughput_kbps: 31.1,
            sparkline: [65, 70, 68, 72, 66, 71, 69, 67, 73, 70],
        },
    ],
    uptime_seconds: 3600,
    source: "demo",
    performance: {
        events_per_sec: 277,
        scan_latency_us: 286,
        simd: detectSimdPath(),
    },
};

/** Check whether the dashboard response is empty (no real data). */
export function isDashboardEmpty(data: DashboardDataResponse): boolean {
    return data.edges.length === 0 && data.total_ebpf_events === 0;
}

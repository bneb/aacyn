/**
 * Rate Limiter — In-memory sliding window for ingest/query endpoints.
 *
 * Per-IP tracking with configurable window size and max requests.
 * No external dependencies — operates entirely in-process.
 *
 * Usage:
 *   import { rateLimiter } from "./lib/rate-limiter";
 *   app.guard({ beforeHandle: [rateLimiter] }, ...)
 */

const WINDOW_MS = 60_000;      // 1 minute sliding window
const MAX_REQUESTS = 1000;     // Max requests per window per IP
const CLEANUP_INTERVAL = 120_000; // Clean expired entries every 2 minutes

interface RateEntry {
    count: number;
    windowStart: number;
}

class RateLimiter {
    private entries = new Map<string, RateEntry>();
    private cleanupTimer: ReturnType<typeof setInterval>;

    constructor() {
        this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL);
    }

    /** Check if a request from the given IP should be allowed. Returns true if allowed. */
    allow(ip: string): boolean {
        const now = Date.now();
        let entry = this.entries.get(ip);

        if (!entry || now - entry.windowStart > WINDOW_MS) {
            // New window
            this.entries.set(ip, { count: 1, windowStart: now });
            return true;
        }

        entry.count++;
        return entry.count <= MAX_REQUESTS;
    }

    /** Number of tracked IPs */
    get trackedCount(): number {
        return this.entries.size;
    }

    /** Stop the cleanup timer */
    stop(): void {
        clearInterval(this.cleanupTimer);
    }

    private cleanup(): void {
        const cutoff = Date.now() - WINDOW_MS;
        for (const [ip, entry] of this.entries) {
            if (entry.windowStart < cutoff) {
                this.entries.delete(ip);
            }
        }
    }
}

export const rateLimiter = new RateLimiter();

/** Elysia beforeHandle hook — blocks rate-limited requests. */
export function requireRateLimit({ set, request }: { set: { status?: number }; request: Request }): Response | void {
    // Skip rate limiting for health/metrics endpoints
    const url = new URL(request.url);
    if (url.pathname === "/health" || url.pathname === "/v1/metrics") return;

    // Trust model: x-real-ip is set by the trusted reverse proxy (e.g. nginx, Envoy)
    // and is a single unspoofable IP. x-forwarded-for can contain multiple comma-separated
    // IPs added by each proxy; the leftmost is the original client. An attacker can set
    // x-forwarded-for directly, so we prefer x-real-ip and only fall back to the leftmost
    // x-forwarded-for when x-real-ip is absent.
    const ip = request.headers.get("x-real-ip") ||
               request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
               "unknown";

    if (!rateLimiter.allow(ip)) {
        set.status = 429;
        return new Response(JSON.stringify({ error: `Rate limit exceeded: max ${MAX_REQUESTS} requests per ${WINDOW_MS / 1000}s window per IP. Retry after the Retry-After header duration.` }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "60" },
        });
    }
}

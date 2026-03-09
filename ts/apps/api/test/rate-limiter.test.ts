/**
 * Tests for the in-memory sliding window rate limiter.
 *
 * Covers: happy path, hard limit enforcement, window expiry, per-IP isolation,
 * bypass paths, and header-based IP extraction.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rateLimiter, requireRateLimit } from "../src/lib/rate-limiter";

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 1000;

/** Saved reference to the real Date.now so we can restore it after each test. */
let savedNow: (() => number) | undefined;

/**
 * Replace Date.now with a mock that returns the given `time` value.
 * The real Date.now is saved and restored in afterEach.
 */
function mockDateNow(time: number): void {
    savedNow = Date.now;
    Date.now = () => time;
}

describe("RateLimiter", () => {
    beforeEach(() => {
        // Stop the background cleanup timer so it never fires during tests
        rateLimiter.stop();
    });

    afterEach(() => {
        if (savedNow) {
            Date.now = savedNow;
            savedNow = undefined;
        }
    });

    test("allows requests within limit", () => {
        const ip = "10.0.0.1";
        for (let i = 0; i < MAX_REQUESTS; i++) {
            expect(rateLimiter.allow(ip)).toBe(true);
        }
    });

    test("blocks requests after exceeding limit", () => {
        const ip = "10.0.0.2";

        // Fill up to the limit (1000 calls — all allowed)
        for (let i = 0; i < MAX_REQUESTS; i++) {
            rateLimiter.allow(ip);
        }

        // The 1001st call exceeds the limit
        expect(rateLimiter.allow(ip)).toBe(false);
    });

    test("resets window after WINDOW_MS expires", () => {
        const ip = "10.0.0.3";

        // Fill past the limit so the IP is blocked
        for (let i = 0; i <= MAX_REQUESTS; i++) {
            rateLimiter.allow(ip);
        }
        expect(rateLimiter.allow(ip)).toBe(false);

        // Advance time past the sliding window — afterEach restores Date.now
        mockDateNow(Date.now() + WINDOW_MS + 1);
        expect(rateLimiter.allow(ip)).toBe(true);
    });

    test("allows requests from different IPs independently", () => {
        const blockedIp = "10.0.0.4";
        const freshIp = "10.0.0.5";

        // Exhaust blockedIp
        for (let i = 0; i <= MAX_REQUESTS; i++) {
            rateLimiter.allow(blockedIp);
        }
        expect(rateLimiter.allow(blockedIp)).toBe(false);

        // A different IP should still be allowed
        expect(rateLimiter.allow(freshIp)).toBe(true);
    });

    test("skips rate limiting for /health path", () => {
        const set: { status?: number } = {};
        const request = new Request("http://localhost/health");

        const result = requireRateLimit({ set, request });

        expect(result).toBeUndefined();
    });

    test("skips rate limiting for /v1/metrics path", () => {
        const set: { status?: number } = {};
        const request = new Request("http://localhost/v1/metrics");

        const result = requireRateLimit({ set, request });

        expect(result).toBeUndefined();
    });

    test("extracts client IP from x-forwarded-for header", () => {
        const clientIp = "203.0.113.42";
        const set: { status?: number } = {};
        const request = new Request("http://localhost/api/ingest", {
            headers: {
                "x-forwarded-for": `${clientIp}, 10.0.0.1, 172.16.0.1`,
            },
        });

        // The first call extracts the IP and is allowed
        const result1 = requireRateLimit({ set, request });
        expect(result1).toBeUndefined();

        // Fill the rate limiter for that extracted IP past the limit
        // (count is already 1 from the requireRateLimit call above)
        for (let i = 0; i < MAX_REQUESTS; i++) {
            rateLimiter.allow(clientIp);
        }

        // Now hit the limit — requireRateLimit should return a 429 response
        const set2: { status?: number } = {};
        const result2 = requireRateLimit({ set: set2, request });
        expect(result2).toBeDefined();
        expect(set2.status).toBe(429);
    });
});

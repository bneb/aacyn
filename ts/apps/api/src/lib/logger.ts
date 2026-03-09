/**
 * Structured Logging — JSON logger with subsystem tagging and request IDs.
 *
 * Uses a lightweight JSON logger compatible with Bun. Each log line is a single
 * JSON object with level, message, subsystem, timestamp, and optional context.
 *
 * Replaces all console.log/warn/error calls across the API server.
 *
 * Usage:
 *   import { createLogger } from "./lib/logger";
 *   const log = createLogger("ebpf");
 *   log.info("Probes attached", { bpfObjPath });
 *   log.warn("Ring buffer drops", { standard: 5, critical: 0 });
 *   log.error("Attach failed", { rc, err });
 */

import pino from "pino";
import { AsyncLocalStorage } from "node:async_hooks";

export const requestContext = new AsyncLocalStorage<string>();

const isProduction = process.env.NODE_ENV === "production";

export const rootLogger = pino({
    level: process.env.LOG_LEVEL || (isProduction ? "info" : "debug"),
    mixin() {
        const requestId = requestContext.getStore();
        return requestId ? { requestId } : {};
    },
    transport: isProduction
        ? undefined
        : {
              target: "pino-pretty",
              options: {
                  colorize: true,
                  translateTime: "SYS:standard",
                  ignore: "pid,hostname",
              },
          },
    base: undefined,
});

/**
 * Creates a structured JSON logger for a given subsystem.
 *
 * In production (NODE_ENV=production), outputs pure JSON to stdout.
 * In development, outputs pretty-printed JSON with colorized level prefixes.
 */
export function createLogger(subsystem: string, bindings: Record<string, unknown> = {}): pino.Logger {
    return rootLogger.child({ subsystem, ...bindings });
}

// Re-export for convenience — subsystems can import this directly
export const log = createLogger("aacyn");

// We export the pino Logger type so consumers can use it if they need type signatures
export type Logger = pino.Logger;

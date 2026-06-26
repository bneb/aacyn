import { Elysia } from "elysia";
import type { HealthResponse, IStore } from "@aacyn/sdk";
import { withStore } from "../lib/store-init";
import { createLogger } from "../lib/logger";
const log = createLogger("routes-health");

const startTime = Date.now();

export interface DeepHealthResponse extends HealthResponse {
    nativeStore: "loaded" | "fallback" | "unavailable";
    ebpf: "attached" | "detached" | "unavailable";
    archiverLag?: number;
    ebpfDrops?: { standard: number; critical: number };
    memoryFootprint?: number;
}

/** Create the base health response with default values. */
function createBaseResponse(): DeepHealthResponse {
    return {
        status: "ok",
        version: "1.0.0-dev",
        uptime: Date.now() - startTime,
        nativeStore: "unavailable",
        ebpf: "unavailable",
    };
}

/** Populate native store status and memory footprint. */
function setNativeStoreStatus(response: DeepHealthResponse, store: IStore): void {
    if (store.constructor.name === "NativeStore") {
        response.nativeStore = "loaded";
        response.memoryFootprint = store.byteSize();
    } else {
        response.nativeStore = "fallback";
    }
}

/** Populate eBPF probe status and ring buffer drop counts. */
function setEbpfStatus(response: DeepHealthResponse, store: IStore): void {
    if (store.constructor.name !== "NativeStore") {
        response.ebpf = "unavailable";
        return;
    }
    const drainCount = store.ebpfDrainCount();
    const drops = store.dropCounts();
    response.ebpf = drainCount > 0 ? "attached" : "detached";
    response.ebpfDrops = drops;
    if (drops.standard > 0 || drops.critical > 0) {
        log.warn(
            `[ebpf] Ring buffer drops detected — standard: ${drops.standard}, critical: ${drops.critical}`
        );
    }
}

/** Populate archiver lag if the archiver module is loaded. */
function setArchiverLag(response: DeepHealthResponse): void {
    try {
        const { archiverState } = require("../archiver") as { archiverState?: { lag: number } };
        if (archiverState) {
            response.archiverLag = archiverState.lag;
        }
    } catch (err) {
        // Archiver module not loaded — omit archiverLag field
    }
}

export const healthRoutes = new Elysia()
    .use(withStore)
    .get("/health", ({ store }): DeepHealthResponse => {
        const response = createBaseResponse();
        setNativeStoreStatus(response, store);
        setEbpfStatus(response, store);
        setArchiverLag(response);
        return response;
    });

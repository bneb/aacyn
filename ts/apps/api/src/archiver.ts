/**
 * Cold Storage Archiver — Background Worker
 *
 * Watches the ring buffer's monotonic head pointer. When enough events
 * have accumulated past the last-archived position, extracts the raw
 * columnar bytes (zero-copy from mmap), compresses with zstd, and
 * uploads to S3-compatible object storage (Cloudflare R2).
 *
 * State is persisted to disk so the archiver can survive restarts.
 * The head pointer is ONLY advanced after a successful upload.
 *
 * File naming: aacyn_archive_${firstTs}_to_${lastTs}.bin.zst
 * Layout:      [timestamps: n*8B][durations: n*4B][is_errors: n*1B]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { init as initZstd, compress as zstdCompress } from "@bokuweb/zstd-wasm";
import {
    S3Client,
    PutObjectCommand,
    type PutObjectCommandInput,
} from "@aws-sdk/client-s3";

import type { NativeStore } from "./lib/native-store";
import { createLogger } from "./lib/logger";
const log = createLogger("archiver");



// Initialize zstd WASM module
let zstdReady = false;
async function ensureZstd() {
    if (!zstdReady) {
        await initZstd();
        zstdReady = true;
    }
}

// ─── Configuration ───────────────────────────────────────────────────────────

const ARCHIVER_STATE_PATH =
    process.env.AACYN_ARCHIVER_STATE ?? "/var/lib/aacyn/archiver_state.json";
const CHUNK_SIZE = Number(process.env.AACYN_ARCHIVER_CHUNK_SIZE ?? 1_000_000);
const POLL_INTERVAL_MS = Number(process.env.AACYN_ARCHIVER_INTERVAL_MS ?? 60_000);

// ─── State Management ────────────────────────────────────────────────────────

interface ArchiverState {
    lastArchivedHead: number;
    totalChunksUploaded: number;
    totalBytesUploaded: number;
}

function loadState(): ArchiverState {
    try {
        if (existsSync(ARCHIVER_STATE_PATH)) {
            const raw = readFileSync(ARCHIVER_STATE_PATH, "utf-8");
            return JSON.parse(raw) as ArchiverState;
        }
    } catch (e) {
        log.warn(`[archiver] Failed to load state: ${(e as Error).message}`);
    }
    return { lastArchivedHead: 0, totalChunksUploaded: 0, totalBytesUploaded: 0 };
}

function saveState(state: ArchiverState): void {
    try {
        const dir = dirname(ARCHIVER_STATE_PATH);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        writeFileSync(ARCHIVER_STATE_PATH, JSON.stringify(state, null, 2));
    } catch (e) {
        log.warn(`[archiver] Failed to save state: ${(e as Error).message}`);
    }
}

// ─── S3 Client ───────────────────────────────────────────────────────────────

function createS3Client(): S3Client | null {
    const endpoint = process.env.S3_ENDPOINT;
    const region = process.env.S3_REGION ?? "auto";
    const accessKeyId = process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

    if (!endpoint || !accessKeyId || !secretAccessKey) {
        return null;
    }

    return new S3Client({
        endpoint,
        region,
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: true,
    });
}

// ─── Core Archive Logic ──────────────────────────────────────────────────────

/**
 * Extract timestamps from a raw columnar buffer to determine the
 * time range for the archive filename.
 */
function extractTimeBounds(
    rawBuffer: Buffer,
    eventCount: number
): { firstTs: number; lastTs: number } {
    const view = new DataView(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.byteLength);

    // Timestamps are at the start: count * 8 bytes
    const firstTsLow = view.getUint32(0, true);
    const firstTsHigh = view.getUint32(4, true);
    const firstTs = firstTsLow + firstTsHigh * 0x100000000;

    const lastOffset = (eventCount - 1) * 8;
    const lastTsLow = view.getUint32(lastOffset, true);
    const lastTsHigh = view.getUint32(lastOffset + 4, true);
    const lastTs = lastTsLow + lastTsHigh * 0x100000000;

    return { firstTs, lastTs };
}

/**
 * Extract raw columnar data from the native store at the given head position.
 * Returns the raw buffer and extracted count, or null if the region was
 * overwritten (advances state past the overwritten region in that case).
 */
async function extractRawChunkData(
    store: NativeStore,
    state: ArchiverState,
    fromHead: number,
    chunkCount: number,
    currentHead: number
): Promise<{ rawBuffer: Buffer; extracted: number } | null> {
    const { buffer: rawBuffer, extracted } = store.extractRaw(fromHead, chunkCount);

    if (extracted === 0) {
        log.warn("[archiver] Extraction returned 0 events — data may have been overwritten");
        // Advance past the overwritten region
        state.lastArchivedHead = currentHead > store.nativeLen() ?
            currentHead - store.nativeLen() : 0;
        saveState(state);
        return null;
    }

    return { rawBuffer, extracted };
}

/**
 * Compress a raw buffer using zstd at compression level 3.
 */
async function compressRawBuffer(rawBuffer: Buffer): Promise<Uint8Array> {
    await ensureZstd();
    const rawBytes = new Uint8Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.byteLength);
    const compressed = zstdCompress(rawBytes, 3);
    const ratio = ((1 - compressed.length / rawBuffer.byteLength) * 100).toFixed(1);

    log.info(
        `[archiver] Compressed: ${(rawBuffer.byteLength / 1024).toFixed(0)}KB → ` +
        `${(compressed.length / 1024).toFixed(0)}KB (${ratio}% reduction)`
    );

    return compressed;
}

/**
 * Upload a compressed archive chunk to S3/R2.
 * Returns the object key on success, or null if the upload failed.
 */
async function uploadArchiveToS3(
    s3: S3Client,
    bucket: string,
    compressed: Uint8Array,
    rawBuffer: Buffer,
    extracted: number,
    fromHead: number
): Promise<string | null> {
    const { firstTs, lastTs } = extractTimeBounds(rawBuffer, extracted);
    const key = `aacyn_archive_${firstTs}_to_${lastTs}.bin.zst`;

    const params: PutObjectCommandInput = {
        Bucket: bucket,
        Key: key,
        Body: compressed,
        ContentType: "application/zstd",
        Metadata: {
            "x-aacyn-events": String(extracted),
            "x-aacyn-from-head": String(fromHead),
            "x-aacyn-raw-bytes": String(rawBuffer.byteLength),
        },
    };

    try {
        await s3.send(new PutObjectCommand(params));
        return key;
    } catch (err) {
        log.error(`[archiver] Upload failed: ${(err as Error).message}`);
        log.error("[archiver] Will retry on next tick. State NOT advanced.");
        return null;
    }
}

/**
 * Persist the archiver state after a successful upload.
 */
function commitArchiveState(
    state: ArchiverState,
    fromHead: number,
    extracted: number,
    compressed: Uint8Array,
    key: string
): void {
    state.lastArchivedHead = fromHead + extracted;
    state.totalChunksUploaded++;
    state.totalBytesUploaded += compressed.length;
    saveState(state);

    log.info(
        `[archiver] Uploaded ${key} (${extracted.toLocaleString()} events, ` +
        `${(compressed.length / 1024).toFixed(0)}KB). Head: ${state.lastArchivedHead}`
    );
}

/**
 * Archives a single chunk: extract -> compress -> upload -> advance state.
 */
export async function archiveChunk(
    store: NativeStore,
    state: ArchiverState,
    s3: S3Client,
    bucket: string
): Promise<boolean> {
    const currentHead = store.head();
    const delta = currentHead - state.lastArchivedHead;

    if (delta < CHUNK_SIZE) {
        return false;
    }

    const chunkCount = Math.min(delta, CHUNK_SIZE);
    const fromHead = state.lastArchivedHead;

    log.info(
        `[archiver] Extracting chunk: head=${fromHead} -> ${fromHead + chunkCount} ` +
        `(${chunkCount.toLocaleString()} events)`
    );

    const chunk = await extractRawChunkData(store, state, fromHead, chunkCount, currentHead);
    if (!chunk) return false;

    const compressed = await compressRawBuffer(chunk.rawBuffer);

    const key = await uploadArchiveToS3(
        s3, bucket, compressed, chunk.rawBuffer, chunk.extracted, fromHead
    );
    if (!key) return false;

    commitArchiveState(state, fromHead, chunk.extracted, compressed, key);
    return true;
}

// ─── Background Worker ───────────────────────────────────────────────────────

let archiverHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Create the polling function that drains all available chunks each tick.
 */
function createArchivePollFn(
    store: NativeStore,
    state: ArchiverState,
    s3: S3Client,
    bucket: string
): () => Promise<void> {
    return async () => {
        try {
            let archived = true;
            while (archived) {
                archived = await archiveChunk(store, state, s3, bucket);
            }
        } catch (err) {
            log.error(`[archiver] Unexpected error: ${(err as Error).message}`);
        }
    };
}

/**
 * Register a SIGTERM handler that saves state on shutdown.
 */
function registerShutdownHandler(state: ArchiverState): void {
    process.on("SIGTERM", () => {
        if (archiverHandle) {
            clearInterval(archiverHandle);
        }
        saveState(state);
        log.info("[archiver] State saved on shutdown");
    });
}

/**
 * Start the archiver background loop.
 * Runs on a configurable interval (default: 60s).
 * No-ops gracefully if S3 credentials aren't configured.
 */
export function startArchiver(store: NativeStore): void {
    const s3 = createS3Client();
    const bucket = process.env.S3_BUCKET;

    if (!s3 || !bucket) {
        log.info(
            "[archiver] S3 not configured — set S3_ENDPOINT, S3_ACCESS_KEY_ID, " +
            "S3_SECRET_ACCESS_KEY, S3_BUCKET to enable cold storage archival"
        );
        return;
    }

    const state = loadState();

    log.info(
        `[archiver] Started — polling every ${POLL_INTERVAL_MS / 1000}s, ` +
        `chunk size: ${CHUNK_SIZE.toLocaleString()}, ` +
        `last archived head: ${state.lastArchivedHead}`
    );

    archiverHandle = setInterval(
        createArchivePollFn(store, state, s3, bucket),
        POLL_INTERVAL_MS
    );

    // Don't prevent process exit
    if (archiverHandle.unref) {
        archiverHandle.unref();
    }

    registerShutdownHandler(state);
}

/**
 * Stop the archiver (for testing).
 */
export function stopArchiver(): void {
    if (archiverHandle) {
        clearInterval(archiverHandle);
        archiverHandle = null;
    }
}

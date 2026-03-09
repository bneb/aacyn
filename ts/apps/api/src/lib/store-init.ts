import { createLogger } from "./logger";
import type { IStore } from "@aacyn/sdk";
import { Elysia } from "elysia";
import type { NativeStore } from "./native-store";

const log = createLogger("store-init");

async function createNativeStore(): Promise<IStore> {
    const { NativeStore: StoreClass } = await import("./native-store");
    const store = new StoreClass(16_000_000);
    log.info("[🛡️ aacyn] Native FFI store active — V8 GC bypassed");
    return store;
}

async function tryAttachEbpf(store: IStore): Promise<void> {
    try {
        const { join, dirname } = await import("path");
        const { existsSync } = await import("fs");
        const projectRoot = dirname(dirname(dirname(dirname(__dirname))));
        const bpfObjPath = process.env.AACYN_BPF_OBJ || join(projectRoot, "build", "aacyn_probes.bpf.o");
        if (!existsSync(bpfObjPath)) {
            log.info(`[🔬 eBPF] No BPF object found at "${bpfObjPath}". Run: make -C native EBPF=1`);
            log.info(`          Or set AACYN_BPF_OBJ to point to your compiled aacyn_probes.bpf.o`);
            return;
        }
        const rc = store.ebpfAttach(bpfObjPath);
        if (rc !== 0) {
            log.warn(`[🔬 eBPF] Attach failed (rc=${rc}) at "${bpfObjPath}". Requires root / CAP_BPF + CAP_SYS_ADMIN.`);
            log.warn(`          Run as root or grant capabilities: sudo setcap cap_bpf,cap_sys_admin+ep $(which bun)`);
            return;
        }
        log.info(`[🔬 eBPF] Probes attached: ${bpfObjPath}`);
        const pollHandle = setInterval(() => store.ebpfPoll(0), 100);
        if (pollHandle.unref) pollHandle.unref();
    } catch (ebpfErr) {
        log.warn(`[🔬 eBPF] Skipped: ${(ebpfErr as Error).message}`);
    }
}

async function tryLoadRules(store: IStore): Promise<void> {
    try {
        const { loadAndCompileRules } = await import("./rules");
        const configPath = process.env.AACYN_CONFIG ?? "aacyn.toml";
        const { buffer, count } = loadAndCompileRules(configPath);
        if (count > 0) store.setRules(buffer, count);
    } catch (ruleErr) {
        log.warn(`[rules] Skipped: ${(ruleErr as Error).message}`);
    }
}

async function tryStartArchiver(store: IStore): Promise<void> {
    // Only the NativeStore backend supports raw columnar extraction for archiving
    if (store.constructor.name !== "NativeStore") {
        log.info("[archiver] Skipped — archiver requires NativeStore backend (V8 MapStore does not support raw extraction)");
        return;
    }
    try {
        const { startArchiver } = await import("../archiver");
        startArchiver(store as NativeStore);
    } catch (archErr) {
        log.warn(`[archiver] Skipped: ${(archErr as Error).message}`);
    }
}

async function createFallbackStore(e: unknown): Promise<IStore> {
    const libPath = process.env.LIBAACYN_PATH || "build/libaacyn.dylib (or libaacyn.so on Linux)";
    log.warn("[⚠️ aacyn] libaacyn native engine not found or failed to load. Falling back to V8 Map store.");
    log.warn("          Metrics only — eBPF and SIMD scanning disabled.");
    log.warn(`          Expected library at: ${libPath}`);
    log.warn(`          Build the native engine: cd native && make && sudo make install`);
    log.warn(`          Or set LIBAACYN_PATH to override the library search path.`);
    if ((e as Error).message.includes("dlopen")) {
        log.warn(`          dlopen error: ${(e as Error).message}`);
    }
    const { store: fallbackStore } = await import("./store");
    return fallbackStore;
}

export async function initializeStore(): Promise<IStore> {
    try {
        const nativeStore = await createNativeStore();
        void tryAttachEbpf(nativeStore);
        await tryLoadRules(nativeStore);
        await tryStartArchiver(nativeStore);
        return nativeStore;
    } catch (e) {
        return createFallbackStore(e);
    }
}

export const withStore = new Elysia({ name: "with-store" }).decorate("store", {} as IStore);

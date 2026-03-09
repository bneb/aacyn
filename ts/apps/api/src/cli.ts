#!/usr/bin/env bun
/**
 * CLI entrypoint for aacyn API.
 *
 * Invocation:
 *   bun run src/cli.ts server --port 3001
 *   bun run src/cli.ts status
 *   bun run src/cli.ts help
 *
 * package.json also registers a "bin" entry ("aacyn": "./dist/cli.js") for
 * distribution via npm. That path resolves when the project is built/compiled;
 * during development use `bun run src/cli.ts` directly.
 */
import { createLogger } from "./lib/logger";

const VERSION = "v1.0.0-dev";
const log = createLogger("cli");

function parseArgs(argv: string[]): { cmd: string; opts: Record<string, string> } {
  const opts: Record<string, string> = {};
  let cmd = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) opts[key] = argv[++i];
      else opts[key] = "true";
    } else if (!cmd) cmd = argv[i];
  }
  return { cmd, opts };
}

function fmtUptime(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return `${h}h ${m}m ${sec}s`;
}

async function cmdServer(opts: Record<string, string>) {
  process.env.PORT = opts.port || "3001";
  process.env.AACYN_MODE = opts.mode || process.env.AACYN_MODE || "standalone";
  const { app } = await import("./server");
  app.listen(Number(process.env.PORT));
  log.info(`aacyn API running at http://localhost:${process.env.PORT}`);
}

async function cmdStatus() {
  let storeType = "fallback (V8MapStore)", ebpfStatus = "detached (not on Linux)";
  let events = 0, bytes = 0, svcs = 0, edges = 0, drops = 0;
  try {
    const { initializeStore } = await import("./lib/store-init");
    const s = await initializeStore();
    events = s.count; bytes = s.byteSize();
    svcs = s.discoveredServices().length; edges = s.topologyEdges().length;
    const d = s.dropCounts(); drops = d.standard + d.critical;
    const { NativeStore } = await import("./lib/native-store");
    if (s instanceof NativeStore) {
      storeType = `loaded (${process.env.LIBAACYN_PATH || "libaacyn.so"})`;
      if (process.platform === "linux") ebpfStatus = `attached (${drops} drops)`;
    }
    s.destroy();
  } catch (e) {
    console.error("CLI: failed to inspect native store:", (e as Error).message);
  }
  console.log(`Version: ${VERSION}
Native engine: ${storeType}
eBPF probes: ${ebpfStatus}
Store: ${events} events stored, ${(bytes / 1024 / 1024).toFixed(1)} MB used
Topology: ${svcs} services discovered, ${edges} edges tracked
Uptime: ${fmtUptime(process.uptime())}
License: free (Apache 2.0)`);
}

function cmdHelp() {
  console.log(`aacyn -- eBPF observability for Kubernetes

Usage:
  aacyn server [--port N] [--mode standalone|aggregator|node|full]
  aacyn status
  aacyn version
  aacyn help
  aacyn bench

Examples:
  aacyn server --port 3001
  aacyn server --mode aggregator
  aacyn status
  aacyn version`);
}

async function cmdBench() {
  const { spawnSync } = await import("node:child_process");
  const root = new URL("../../../..", import.meta.url).pathname;
  const result = spawnSync("./run.sh", [], { cwd: `${root}/benchmarks`, stdio: "inherit" });
  process.exit(result.status ?? 1);
}

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  switch (cmd || "server") {
    case "server": return cmdServer(opts);
    case "status": return cmdStatus();
    case "version": console.log(VERSION); return;
    case "help": return cmdHelp();
    case "bench": return cmdBench();
    default:
      console.error(`Unknown command: ${cmd}`);
      cmdHelp();
      process.exit(1);
  }
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });

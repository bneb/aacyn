import { test, expect, describe, afterEach, mock, beforeAll } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { TopologyGraph, NO_SERVICES_DISCOVERED_MSG, EBPF_UNAVAILABLE_MSG, NO_EDGES_OBSERVED_MSG } from "../TopologyGraph";
import * as React from "react";
import type { Window as HappyDomWindow } from "happy-dom";

// ── Happy DOM setup ─────────────────────────────────────────────────
// @testing-library/react needs a browser-like DOM environment.
// happy-dom is a devDependency of packages/ui.
let win: HappyDomWindow;

beforeAll(() => {
  const { Window } = require("happy-dom");
  win = new Window({ url: "http://localhost:3000" });

  // Core DOM globals that @testing-library/react and the component need
  const globalKeys: string[] = [
    "window", "document", "navigator",
    "HTMLElement", "HTMLDivElement", "HTMLSpanElement", "HTMLParagraphElement",
    "HTMLHeadingElement", "HTMLCanvasElement",
    "HTMLInputElement", "HTMLButtonElement", "HTMLAnchorElement",
    "Node", "Event", "EventTarget", "CustomEvent",
    "MouseEvent", "KeyboardEvent", "FocusEvent",
    "Text", "Comment", "DocumentFragment",
    "DOMRect", "DOMRectReadOnly",
  ];
  for (const key of globalKeys) {
    if (win[key] !== undefined) {
      // @ts-ignore
      globalThis[key] = win[key];
    }
  }

  // Timer functions — React's scheduler and the component's
  // requestAnimationFrame loop depend on these.
  globalThis.setTimeout = win.setTimeout.bind(win);
  globalThis.clearTimeout = win.clearTimeout.bind(win);
  globalThis.setInterval = win.setInterval.bind(win);
  globalThis.clearInterval = win.clearInterval.bind(win);
  globalThis.requestAnimationFrame = win.requestAnimationFrame.bind(win);
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
});

// ── Test helpers ────────────────────────────────────────────────────

/** Snapshot of Bun's native fetch before any test overrides */
const nativeFetch = globalThis.fetch;

function resetTestEnv() {
  cleanup();
  globalThis.fetch = nativeFetch;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("TopologyGraph - loading states", () => {
  afterEach(resetTestEnv);

  test("renders loading topology state initially when no data is provided", () => {
    render(<TopologyGraph pollInterval={100000} />);
    expect(document.body.innerHTML).toContain("Loading topology...");
  });

  test("displays error message when fetch rejects", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("Network error")));
    render(<TopologyGraph pollInterval={10} />);

    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 10));
      if (document.body.innerHTML.includes("Dashboard unavailable")) break;
    }

    expect(document.body.innerHTML).toContain("Dashboard unavailable");
  });
});

describe("TopologyGraph - empty data states", () => {
  afterEach(resetTestEnv);

  test("displays no services discovered message when source is none", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      source: "none",
      total_ebpf_events: 0,
      edges: [],
      drops: { standard: 0, critical: 0 },
      golden_signals: [],
      uptime_seconds: 100,
    }), { headers: { "Content-Type": "application/json" } })));

    render(<TopologyGraph pollInterval={10} />);
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 10));
      if (document.body.innerHTML.includes(NO_SERVICES_DISCOVERED_MSG)) break;
    }
    expect(document.body.innerHTML).toContain(NO_SERVICES_DISCOVERED_MSG);
  });

  test("displays no edges observed message when edges are empty but probe is active", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      source: "ebpf",
      total_ebpf_events: 100,
      edges: [],
      drops: { standard: 0, critical: 0 },
      golden_signals: [],
      uptime_seconds: 100,
    }), { headers: { "Content-Type": "application/json" } })));

    render(<TopologyGraph pollInterval={10} />);
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 10));
      if (document.body.innerHTML.includes(NO_EDGES_OBSERVED_MSG)) break;
    }
    expect(document.body.innerHTML).toContain(NO_EDGES_OBSERVED_MSG);
  });
});

describe("TopologyGraph - with data", () => {
  afterEach(resetTestEnv);

  test("renders canvas when edges are present", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      source: "ebpf",
      total_ebpf_events: 100,
      edges: [{
        source: "A", target: "B", hit_count: 1, latency_us: 100,
        bytes_transferred: 100, protocol: "tcp", error_count: 0,
      }],
      drops: { standard: 0, critical: 0 },
      golden_signals: [],
      uptime_seconds: 100,
    }), { headers: { "Content-Type": "application/json" } })));

    render(<TopologyGraph pollInterval={10} />);
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 10));
      if (document.querySelector("canvas")) break;
    }
    expect(document.querySelector("canvas")).not.toBeNull();
  });
});

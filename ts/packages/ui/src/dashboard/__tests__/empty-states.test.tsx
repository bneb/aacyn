import { describe, it, expect } from "bun:test";
import {
    TopologyGraph, EBPF_UNAVAILABLE_MSG, NO_SERVICES_DISCOVERED_MSG, NO_EDGES_OBSERVED_MSG,
} from "../TopologyGraph";
import {
    GoldenSignals, COLLECTING_DATA_MSG, NO_SERVICES_YET_MSG,
} from "../GoldenSignals";
import {
    EvidenceFeed, WAITING_FOR_KERNEL_EVENTS_MSG,
} from "../EvidenceFeed";

/** Helper: assert a string message export has expected type, min length, and content. */
function expectStringMessage(msg: string, minLength: number, ...contains: string[]) {
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(minLength);
    for (const s of contains) {
        expect(msg).toContain(s);
    }
}

describe("Dashboard empty state messages are exported", () => {
    it("EBPF_UNAVAILABLE_MSG mentions Linux kernel and eBPF", () => {
        expectStringMessage(EBPF_UNAVAILABLE_MSG, 50, "Linux kernel", "eBPF");
    });

    it("NO_SERVICES_DISCOVERED_MSG provides actionable guidance", () => {
        expectStringMessage(NO_SERVICES_DISCOVERED_MSG, 50, "Check", "eBPF");
    });

    it("NO_EDGES_OBSERVED_MSG mentions TCP connections", () => {
        expectStringMessage(NO_EDGES_OBSERVED_MSG, 1, "TCP");
    });

    it("COLLECTING_DATA_MSG explains the 30-second window", () => {
        expectStringMessage(COLLECTING_DATA_MSG, 1, "30 seconds", "golden signals");
    });

    it("NO_SERVICES_YET_MSG is a short fallback", () => {
        expectStringMessage(NO_SERVICES_YET_MSG, 10);
    });

    it("WAITING_FOR_KERNEL_EVENTS_MSG explains kernel syscalls", () => {
        expectStringMessage(WAITING_FOR_KERNEL_EVENTS_MSG, 1, "kernel", "connect()", "sendmsg()");
    });
});

describe("Component function signatures", () => {
    it("TopologyGraph is a function component", () => {
        expect(typeof TopologyGraph).toBe("function");
    });

    it("GoldenSignals is a function component", () => {
        expect(typeof GoldenSignals).toBe("function");
    });

    it("EvidenceFeed is a function component", () => {
        expect(typeof EvidenceFeed).toBe("function");
    });
});

describe("Empty state message uniqueness", () => {
    it("all 6 exported messages are unique", () => {
        const messages = new Set([
            EBPF_UNAVAILABLE_MSG, NO_SERVICES_DISCOVERED_MSG, NO_EDGES_OBSERVED_MSG,
            COLLECTING_DATA_MSG, NO_SERVICES_YET_MSG, WAITING_FOR_KERNEL_EVENTS_MSG,
        ]);
        expect(messages.size).toBe(6);
    });

    it("every message contains actionable guidance", () => {
        const messages = [EBPF_UNAVAILABLE_MSG, NO_SERVICES_DISCOVERED_MSG, NO_EDGES_OBSERVED_MSG,
            COLLECTING_DATA_MSG, NO_SERVICES_YET_MSG, WAITING_FOR_KERNEL_EVENTS_MSG];
        for (const msg of messages) {
            const hasGuidance = msg.includes("Check") || msg.includes("Deploy") ||
                msg.includes("Generate") || msg.includes("enough") || msg.includes("waiting") ||
                msg.includes("need") || msg.includes("Deploy via");
            expect(hasGuidance).toBe(true);
        }
    });
});

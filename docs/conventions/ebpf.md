---
path: native/**/*.bpf.c
---

# eBPF Probe Rules

## Architecture
- `aacyn_probes.bpf.c` — V2 dual ring buffers: `standard_events` (256KB) + `critical_errors` (64KB).
- `aacyn_auto.bpf.c` — Service auto-discovery via `accept4` tracepoints.
- Three hook points: `tracepoint/syscalls/sys_enter_connect`, `sys_exit_connect`, `kprobe/tcp_sendmsg`.
- CO-RE socket introspection: walks `task_struct → files → fdt → fd[] → private_data → socket → sk` to extract source IP.
- Topology edge tracking in user-space consumer (libaacyn.c `ebpf_event_handler`).

## Kernel Verifier Constraints (Non-Negotiable)
- All loops must have compile-time-constant bounds (use `#pragma unroll` or fixed iteration count).
- All pointer dereferences must go through `bpf_probe_read()` / `bpf_probe_read_kernel()` / `BPF_CORE_READ()`.
- Stack usage ≤ 512 bytes per program. Large structs go in per-CPU maps.
- Map sizes must be declared. No dynamic allocation.
- Helper functions only from the allowed list (`bpf_get_current_pid_tgid`, `bpf_ringbuf_output`, etc.).
- CO-RE relocations require `vmlinux.h` generated from target kernel BTF.

## Testing
- Must pass kernel verifier on target kernel versions (5.15 LTS minimum).
- Test with `bpftool prog load` before committing.
- Verify ring buffer behavior under load — the `drop_counters` map must increment when buffers are full.
- Test on actual Linux kernel (Docker `--privileged` with BTF mounted, or VM).

## Common Pitfalls
- `vmlinux.h` from one kernel version may use different struct layouts than another — CO-RE relocations handle this, but field offsets must be accessed via `BPF_CORE_READ` not direct pointer deref.
- `AF_INET` is not defined in `vmlinux.h` — define it explicitly: `#define AF_INET 2`.
- Ring buffer reservation can fail — always check return value of `bpf_ringbuf_reserve()`.
- Per-CPU maps need `BPF_MAP_TYPE_PERCPU_ARRAY` for drop counters shared across CPUs.
- The `connect_state` hash map must be cleaned up on `sys_exit_connect` to prevent leaks — always delete the entry after consuming it.

/*
 * aacyn eBPF Auto-Discovery Probes — Service Auto-Detection
 *
 * Extends aacyn_probes.bpf.c with probes that detect listening servers
 * and map PIDs to services. When a process calls accept() or listen(),
 * we record it as a "discovered service" in a BPF hash map.
 *
 * Tracepoints:
 *   - tracepoint/syscalls/sys_enter_accept4  (incoming connections)
 *   - tracepoint/syscalls/sys_exit_accept4    (successful accept with fd)
 *
 * This complements the existing probes in aacyn_probes.bpf.c which
 * handle outbound connections and sends.
 *
 * Build (Linux only):
 *   clang -target bpf -O2 -g -c aacyn_auto.bpf.c -o aacyn_auto.bpf.o
 *
 * Requires:
 *   - Linux kernel 5.8+ with CONFIG_BPF=y
 *   - vmlinux.h
 *   - libbpf headers
 */

#include "vmlinux.h"
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

#ifndef AF_INET
#define AF_INET 2
#endif

/* ─── Discovered Service Event ───────────────────────────────────────────── */
/* Emitted when a process accepts an incoming connection.                    */

struct service_event {
  __u64 timestamp_ns;   /* bpf_ktime_get_ns() */
  __u32 pid;            /* Server PID */
  __u32 tgid;
  __u16 listen_port;    /* Port the server is listening on */
  __u16 event_type;     /* 0 = accept, 1 = listen */
  __u32 client_ip;      /* Client IPv4 address */
  __u64 accept_latency; /* ns between enter and exit of accept() */
  char comm[16];        /* Server process name (task_comm) */
} __attribute__((packed));

/* ─── BPF Maps ───────────────────────────────────────────────────────────── */

struct {
  __uint(type, BPF_MAP_TYPE_RINGBUF);
  __uint(max_entries, 256 * 1024); /* 256 KB */
} discovery_ringbuf SEC(".maps");

/* Track accept() enter timestamps for latency measurement */
struct {
  __uint(type, BPF_MAP_TYPE_HASH);
  __uint(max_entries, 65536);
  __type(key, __u64);   /* pid_tgid */
  __type(value, __u64); /* enter timestamp */
} accept_timestamps SEC(".maps");

/* Track accept() sockaddr for port extraction */
struct {
  __uint(type, BPF_MAP_TYPE_HASH);
  __uint(max_entries, 65536);
  __type(key, __u64);   /* pid_tgid */
  __type(value, __u64); /* pointer to sockaddr (user-space) */
} accept_addrs SEC(".maps");

/* ─── Tracepoint: sys_enter_accept4 ──────────────────────────────────────── */
/* Fires when a process calls accept4(). Record timestamp.                  */

SEC("tracepoint/syscalls/sys_enter_accept4")
int trace_accept_enter(struct trace_event_raw_sys_enter *ctx) {
  __u64 pid_tgid = bpf_get_current_pid_tgid();

  /* Record enter timestamp for accept latency */
  __u64 ts = bpf_ktime_get_ns();
  bpf_map_update_elem(&accept_timestamps, &pid_tgid, &ts, BPF_ANY);

  /* Save the addr pointer for later (sys_exit will give us the fd) */
  __u64 addr_ptr = ctx->args[1]; /* struct sockaddr __user *upeer_sockaddr */
  bpf_map_update_elem(&accept_addrs, &pid_tgid, &addr_ptr, BPF_ANY);

  return 0;
}

/* ─── Tracepoint: sys_exit_accept4 ───────────────────────────────────────── */
/* Fires when accept4() returns. Emit a discovery event if successful.      */

SEC("tracepoint/syscalls/sys_exit_accept4")
int trace_accept_exit(struct trace_event_raw_sys_exit *ctx) {
  __u64 pid_tgid = bpf_get_current_pid_tgid();

  /* Only emit on successful accept (retval >= 0 is the new fd) */
  long retval = ctx->ret;
  if (retval < 0)
    return 0;

  /* Look up enter timestamp */
  __u64 *enter_ts = bpf_map_lookup_elem(&accept_timestamps, &pid_tgid);
  if (!enter_ts)
    return 0;

  __u64 latency_ns = bpf_ktime_get_ns() - *enter_ts;
  bpf_map_delete_elem(&accept_timestamps, &pid_tgid);

  /* Read the client sockaddr to get the port */
  __u16 listen_port = 0;
  __u32 client_ip = 0;
  __u64 *addr_ptr_val = bpf_map_lookup_elem(&accept_addrs, &pid_tgid);
  if (addr_ptr_val) {
    struct sockaddr_in addr = {};
    if (bpf_probe_read_user(&addr, sizeof(addr), (void *)*addr_ptr_val) == 0) {
      if (addr.sin_family == AF_INET) {
        listen_port = addr.sin_port;
        client_ip = addr.sin_addr.s_addr;
      }
    }
    bpf_map_delete_elem(&accept_addrs, &pid_tgid);
  }

  /* Reserve and submit discovery event */
  struct service_event *event;
  event = bpf_ringbuf_reserve(&discovery_ringbuf, sizeof(*event), 0);
  if (!event)
    return 0;

  event->timestamp_ns = bpf_ktime_get_ns();
  event->pid = (__u32)(pid_tgid >> 32);
  event->tgid = (__u32)pid_tgid;
  event->listen_port = listen_port;
  event->event_type = 0; /* accept */
  event->client_ip = client_ip;
  event->accept_latency = latency_ns;
  bpf_get_current_comm(event->comm, sizeof(event->comm));

  bpf_ringbuf_submit(event, 0);
  return 0;
}

char LICENSE[] SEC("license") = "GPL";

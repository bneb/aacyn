/*
 * aacyn eBPF Kernel Probes — Zero-Instrumentation Telemetry
 *
 * Intercepts network syscalls at the kernel level and pipes events
 * directly into a shared ring buffer. The user-space consumer in
 * libaacyn.c drains the ring buffer and appends into the mmap'd
 * SoA columnar store — completely bypassing the HTTP/JSON layer.
 *
 * Tracepoints:
 *   - tracepoint/syscalls/sys_enter_connect  (outbound TCP)
 *   - kprobe/tcp_sendmsg                      (active sends)
 *
 * Build (Linux only):
 *   clang -target bpf -O2 -g -c aacyn_probes.bpf.c -o aacyn_probes.bpf.o
 *
 * Requires:
 *   - Linux kernel 5.8+ with CONFIG_BPF=y
 *   - vmlinux.h (generated via: bpftool btf dump file /sys/kernel/btf/vmlinux
 * format c)
 *   - libbpf headers
 */

#include "vmlinux.h"
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

/* vmlinux.h from BTF doesn't include socket constants or stdbool */
#ifndef AF_INET
#define AF_INET 2
#endif

#ifndef __bool_true_false_are_defined
typedef _Bool bool;
#define true  1
#define false 0
#endif

/* ── Kernel types not in vmlinux.h ───────────────────────────────────────── */
/* vmlinux.h is hand-crafted and may not include every kernel type used      */
/* by the probes. These structs are stable kernel ABI — field offsets are    */
/* resolved at load time via CO-RE relocations, so the definitions here are  */
/* minimal: only the fields accessed by our probes need to be present.       */

#ifndef __AACYN_IOVEC_DEFINED
#define __AACYN_IOVEC_DEFINED
struct iovec {
	void *iov_base;
	__kernel_size_t iov_len;
};
#endif

#ifndef __AACYN_MSGITER_DEFINED
#define __AACYN_MSGITER_DEFINED
struct msg_iter {
	struct iovec *__iov;
};
#endif

#ifndef __AACYN_MSGHDR_DEFINED
#define __AACYN_MSGHDR_DEFINED
struct msghdr {
	struct msg_iter msg_iter;
};
#endif

/* ─── Shared Event Structure ─────────────────────────────────────────────── */
/* Must match the struct in libaacyn.c for zero-copy ring buffer transfer.   */

struct network_event {
  __u64 timestamp_ns; /* bpf_ktime_get_ns() monotonic clock */
  __u32 pid;          /* Process ID */
  __u32 tgid;         /* Thread Group ID */
  __u32 dest_ip;      /* Destination IPv4 (network byte order) */
  __u32 source_ip;    /* Source IPv4 (network byte order) — container identity */
  __u16 dest_port;    /* Destination port (network byte order) */
  __u16 status;       /* 0=connect, 1=connected, 2=send, 3=connect_failed,
                         4=retransmit, 5=HTTP/gRPC req, 6=HTTP/gRPC resp */
  __u8  protocol;     /* 0=unknown, 1=HTTP/1.x, 2=HTTP/2, 3=gRPC */
  __u8  path_len;     /* Length of path/service:method string in path[] */
  __u64 bytes;        /* HTTP: (http_status<<16)|(method<<8)|path_len;
                         gRPC: (grpc_status_code<<16) */
  char comm[16];      /* Process name (TASK_COMM_LEN) */
  /* ── Distributed Tracing Fields ────────────────────────────────────── */
  char trace_id[16];  /* 128-bit W3C trace ID (zero if no traceparent) */
  __u64 span_id;      /* 64-bit span ID (zero if no trace context) */
  __u64 parent_span_id; /* 64-bit parent span ID (zero for root spans) */
  /* ── Protocol-Specific Path / Service:Method ───────────────────────── */
  char path[32];      /* HTTP: request path (truncated); gRPC: "service:method" */
} __attribute__((packed));

/*
 * NOTE: eBPF changes CANNOT be tested on macOS.
 * Kernel testing is required on Linux with a real kernel (5.15+).
 * Use: make EBPF=1 && sudo bun run src/index.ts
 */

/* ─── V2 BPF Maps ─────────────────────────────────────────────────────────────── */

/* 1. High-Volume Telemetry Buffer (HTTP 200s, normal connects, sends) */
struct {
  __uint(type, BPF_MAP_TYPE_RINGBUF);
  __uint(max_entries, 256 * 1024); /* 256 KB */
} standard_events SEC(".maps");

/* 2. High-Priority Error Buffer (failed connects, timeouts) */
struct {
  __uint(type, BPF_MAP_TYPE_RINGBUF);
  __uint(max_entries, 64 * 1024); /* 64 KB */
} critical_errors SEC(".maps");

/* 3. Observable Backpressure Counters (Per-CPU to avoid lock contention) */
/* Index 0: Standard Drops, Index 1: Critical Drops                      */
struct {
  __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
  __type(key, __u32);
  __type(value, __u64);
  __uint(max_entries, 2);
} drop_counters SEC(".maps");

/* Per-connect state: stash timestamp + fd for exit handler */
struct connect_info {
  __u64 enter_ts;   /* bpf_ktime_get_ns() at sys_enter_connect */
  __u32 fd;         /* File descriptor for socket introspection */
  __u32 dest_ip;    /* Destination IP (stashed for exit handler) */
  __u16 dest_port;  /* Destination port (stashed for exit handler) */
  __u16 _pad;
};

struct {
  __uint(type, BPF_MAP_TYPE_HASH);
  __uint(max_entries, 65536);
  __type(key, __u64);              /* pid_tgid */
  __type(value, struct connect_info);
} connect_state SEC(".maps");

/* ─── V2 Event Routing: Priority-Based Ring Buffer Selection ───────────── */
/* Routes events to standard_events or critical_errors based on severity. */
/* On buffer-full, atomically increments the Per-CPU drop counter.        */

static __always_inline void emit_event(struct network_event *event,
                                       bool is_critical) {
  void *ringbuf = is_critical ? &critical_errors : &standard_events;
  __u32 drop_index = is_critical ? 1 : 0;

  struct network_event *e = bpf_ringbuf_reserve(ringbuf, sizeof(*e), 0);
  if (!e) {
    /* BUFFER FULL: Observable Backpressure */
    __u64 *counter = bpf_map_lookup_elem(&drop_counters, &drop_index);
    if (counter)
      __sync_fetch_and_add(counter, 1);
    return;
  }

  *e = *event;
  bpf_ringbuf_submit(e, 0);
}

/* ─── Tracepoint: sys_enter_connect ────────────────────────────────────── */
/* Fires when any process calls connect(). Captures destination address. */
/* Severity: STANDARD (normal telemetry)                                 */

SEC("tracepoint/syscalls/sys_enter_connect")
int trace_connect_enter(struct trace_event_raw_sys_enter *ctx) {
  __u64 pid_tgid = bpf_get_current_pid_tgid();
  __u32 pid = pid_tgid >> 32;

  /* Extract sockaddr from connect(fd, addr, addrlen) */
  struct sockaddr_in addr = {};
  void *addr_ptr = (void *)ctx->args[1];

  if (bpf_probe_read_user(&addr, sizeof(addr), addr_ptr) < 0)
    return 0;

  /* Only capture IPv4 TCP connections */
  if (addr.sin_family != AF_INET)
    return 0;

  /* Stash fd + timestamp + dest for the exit handler */
  __u64 ts = bpf_ktime_get_ns();
  struct connect_info info = {};
  info.enter_ts = ts;
  info.fd = (__u32)ctx->args[0];
  info.dest_ip = addr.sin_addr.s_addr;
  info.dest_port = addr.sin_port;
  bpf_map_update_elem(&connect_state, &pid_tgid, &info, BPF_ANY);

  /* Emit connect-enter event (source_ip = 0, not yet bound) */
  struct network_event event = {};
  event.timestamp_ns = ts;
  event.pid = pid;
  event.tgid = (__u32)pid_tgid;
  event.dest_ip = addr.sin_addr.s_addr;
  event.source_ip = 0; /* Unknown at enter time */
  event.dest_port = addr.sin_port;
  event.status = 0; /* connect */
  event.protocol = 0; /* unknown protocol for raw connect */
  event.bytes = 0;
  bpf_get_current_comm(event.comm, sizeof(event.comm));

  emit_event(&event, false); /* STANDARD */

  return 0;
}

/* ─── Tracepoint: sys_exit_connect ─────────────────────────────────────── */
/* Fires when connect() returns. Computes connection setup latency.      */
/* Severity: CRITICAL if connect failed, STANDARD otherwise.             */

SEC("tracepoint/syscalls/sys_exit_connect")
int trace_connect_exit(struct trace_event_raw_sys_exit *ctx) {
  __u64 pid_tgid = bpf_get_current_pid_tgid();

  /* Look up stashed connect info */
  struct connect_info *info = bpf_map_lookup_elem(&connect_state, &pid_tgid);
  if (!info)
    return 0;

  __u64 duration_ns = bpf_ktime_get_ns() - info->enter_ts;
  __u32 saved_fd = info->fd;
  __u32 saved_dest_ip = info->dest_ip;
  __u16 saved_dest_port = info->dest_port;
  bpf_map_delete_elem(&connect_state, &pid_tgid);

  long retval = ctx->ret;
  bool is_error = (retval != 0 && retval != -115 /* EINPROGRESS */);

  /*
   * Read the socket's local IP (source_ip) via fd → socket → sock.
   * Walk: current→files→fdt→fd[fd]→private_data (struct socket *)→sk→skc_rcv_saddr
   * This is the container's bridge IP, giving us a stable node identity.
   */
  __u32 source_ip = 0;
  struct task_struct *task = (struct task_struct *)bpf_get_current_task();
  struct file **fd_array;
  fd_array = BPF_CORE_READ(task, files, fdt, fd);
  if (fd_array) {
    struct file *f = NULL;
    bpf_probe_read_kernel(&f, sizeof(f), &fd_array[saved_fd & 0xFFFF]);
    if (f) {
      struct socket *socket = BPF_CORE_READ(f, private_data);
      if (socket) {
        struct sock *sk = BPF_CORE_READ(socket, sk);
        if (sk) {
          source_ip = BPF_CORE_READ(sk, __sk_common.skc_rcv_saddr);
        }
      }
    }
  }

  /* Build event on stack and emit via priority router */
  struct network_event event = {};
  event.timestamp_ns = bpf_ktime_get_ns();
  event.pid = (__u32)(pid_tgid >> 32);
  event.tgid = (__u32)pid_tgid;
  event.dest_ip = saved_dest_ip;
  event.source_ip = source_ip;
  event.dest_port = saved_dest_port;
  event.status = is_error ? 3 : 1;
  event.protocol = 0; /* unknown protocol for connect events */
  event.bytes = is_error ? (__u64)(-retval) : duration_ns;
  bpf_get_current_comm(event.comm, sizeof(event.comm));

  emit_event(&event, is_error); /* CRITICAL on failure */

  return 0;
}

/* ─── Kprobe: tcp_sendmsg ──────────────────────────────────────────────── */
/* Fires on every TCP send. Captures bytes sent for throughput metric.   */
/* Severity: STANDARD (normal telemetry)                                */

SEC("kprobe/tcp_sendmsg")
int trace_tcp_sendmsg(struct pt_regs *ctx) {
  __u64 pid_tgid = bpf_get_current_pid_tgid();
  __u32 pid = pid_tgid >> 32;

  /* arg1 = struct sock *sk, arg3 = size_t len */
  struct sock *sk = (struct sock *)PT_REGS_PARM1(ctx);
  size_t bytes_sent = PT_REGS_PARM3(ctx);

  /* Read source and dest IPs from the connected socket */
  __u32 source_ip = BPF_CORE_READ(sk, __sk_common.skc_rcv_saddr);
  __u32 dest_ip = BPF_CORE_READ(sk, __sk_common.skc_daddr);
  __u16 dest_port = BPF_CORE_READ(sk, __sk_common.skc_dport);

  struct network_event event = {};
  event.timestamp_ns = bpf_ktime_get_ns();
  event.pid = pid;
  event.tgid = (__u32)pid_tgid;
  event.dest_ip = dest_ip;
  event.source_ip = source_ip;
  event.dest_port = dest_port;
  event.status = 2; /* send */
  event.protocol = 0; /* unknown protocol for raw send */
  event.bytes = bytes_sent;
  bpf_get_current_comm(event.comm, sizeof(event.comm));

  emit_event(&event, false); /* STANDARD */

  return 0;
}

/* ─── Kprobe: tcp_retransmit_skb ─────────────────────────────────────────── */
/* Fires on every TCP retransmission. Captures packet loss at the kernel   */
/* level — invisible to application monitoring.                            */
/* Severity: STANDARD (per-retransmit telemetry).                          */
/* Event status: 4 (retransmit) — user-space increments retransmit_count   */

SEC("kprobe/tcp_retransmit_skb")
int trace_tcp_retransmit(struct pt_regs *ctx) {
  __u64 pid_tgid = bpf_get_current_pid_tgid();
  __u32 pid = pid_tgid >> 32;

  /* arg1 = struct sock *sk */
  struct sock *sk = (struct sock *)PT_REGS_PARM1(ctx);

  /* Read connection identity from the socket */
  __u32 source_ip = BPF_CORE_READ(sk, __sk_common.skc_rcv_saddr);
  __u32 dest_ip = BPF_CORE_READ(sk, __sk_common.skc_daddr);
  __u16 dest_port = BPF_CORE_READ(sk, __sk_common.skc_dport);

  struct network_event event = {};
  event.timestamp_ns = bpf_ktime_get_ns();
  event.pid = pid;
  event.tgid = (__u32)pid_tgid;
  event.dest_ip = dest_ip;
  event.source_ip = source_ip;
  event.dest_port = dest_port;
  event.status = 4; /* retransmit */
  event.protocol = 0; /* unknown protocol for retransmit */
  event.bytes = 1;  /* count one retransmit event */
  bpf_get_current_comm(event.comm, sizeof(event.comm));

  emit_event(&event, false); /* STANDARD */

  return 0;
}

/* ─── Kprobe: tcp_recvmsg (HTTP/1.1 Parser + Traceparent) ───────────────── */
/* Peek at the first 512 bytes of inbound TCP payload to extract HTTP      */
/* method, path, response status code, and W3C traceparent header.         */
/* Uses bounded loops (#pragma unroll) to satisfy the BPF verifier.        */
/* Severity: STANDARD. Event status: 5 (HTTP request), 6 (HTTP response). */
/*                                                                         */
/* NOTE: eBPF changes require kernel testing on Linux (5.15+).             */
/* Build: clang -target bpf -O2 -g -c aacyn_probes.bpf.c -o ...           */

#define HTTP_PEEK_MAX 512

/* ── Hex conversion helper for traceparent parsing ───────────────────────── */

static __always_inline unsigned char hex_char_to_u8(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return 0;
}

/* ── Hash helper: derive a 64-bit span_id from available context ────────── */

static __always_inline __u64 make_span_id(__u32 pid, __u32 tgid, __u64 ts,
                                           __u32 dest_ip, __u16 dest_port) {
  /* Simple XOR-based hash — provides reasonable uniqueness per connection */
  return (__u64)pid ^ ((__u64)tgid << 32) ^ ts ^ (__u64)dest_ip ^ ((__u64)dest_port << 16);
}

/* ── gRPC detection: scan payload for HTTP/2 preface and grpc content-type ─ */
/* Returns protocol: 1 = HTTP/1.x, 2 = HTTP/2, 3 = gRPC                   */
/* Also extracts the :path / service:method into path_buf if gRPC detected */
/* Must be called before parse_traceparent (both scan the buffer).         */
#define GRPC_PATH_MAX 32

static __always_inline unsigned char detect_protocol(const unsigned char *buf,
                                                      size_t buf_len,
                                                      unsigned char is_response,
                                                      char *path_buf,
                                                      unsigned char *out_path_len) {
  unsigned char proto = 1; /* Default: assume HTTP/1.x */

  /* Detect HTTP/2 response: "HTTP/2" at position 0 */
  if (is_response && buf_len >= 8 &&
      buf[0] == 'H' && buf[1] == 'T' && buf[2] == 'T' && buf[3] == 'P' &&
      buf[4] == '/' && buf[5] == '2') {
    proto = 2; /* HTTP/2 */
  }

  /* Detect HTTP/2 request: "PRI * HTTP/2.0" connection preface */
  if (!is_response && buf_len >= 14 &&
      buf[0] == 'P' && buf[1] == 'R' && buf[2] == 'I' &&
      buf[3] == ' ' && buf[4] == '*' &&
      buf[5] == ' ' && buf[6] == 'H' && buf[7] == 'T' &&
      buf[8] == 'T' && buf[9] == 'P' && buf[10] == '/' &&
      buf[11] == '2' && buf[12] == '.' && buf[13] == '0') {
    proto = 2; /* HTTP/2 */
  }

  /* Scan for "grpc" substring to detect gRPC content-type */
  /* This works when HPACK uses literal encoding or when the */
  /* content-type header value appears in the raw bytes.     */
  unsigned char found_grpc = 0;
  #pragma unroll
  for (int i = 0; i < 480; i++) {
    if (i + 4 >= (int)buf_len) break;
    if ((buf[i] == 'g' || buf[i] == 'G') &&
        (buf[i+1] == 'r' || buf[i+1] == 'R') &&
        (buf[i+2] == 'p' || buf[i+2] == 'P') &&
        (buf[i+3] == 'c' || buf[i+3] == 'C')) {
      found_grpc = 1;
      break;
    }
  }

  if (found_grpc) {
    proto = 3; /* gRPC */
    /* Attempt to extract gRPC :path pseudo-header (e.g. /package.Service/Method) */
    /* Look for '/' followed by alphanumeric chars and '.' then '/' */
    unsigned char path_started = 0;
    unsigned char path_pos = 0;
    unsigned char path_found = 0;
    #pragma unroll
    for (int i = 0; i < 480; i++) {
      if (i + 1 >= (int)buf_len) break;
      if (!path_started) {
        /* Find a '/' preceded by space, colon, or at the start of relevant data */
        if (buf[i] == '/' && (i == 0 || buf[i-1] == ' ' || buf[i-1] == ':' ||
                             buf[i-1] == '\t')) {
          path_started = 1;
          path_pos = 0;
          path_buf[path_pos++] = buf[i];
        }
      } else {
        if (buf[i] == ' ' || buf[i] == '\r' || buf[i] == '\n' ||
            buf[i] == '\t' || buf[i] == ')' || path_pos >= GRPC_PATH_MAX - 1) {
          /* End of path reached */
          if (path_pos >= 3) {
            /* Valid gRPC path must contain '.' and '/' after first char */
            unsigned char has_dot = 0;
            unsigned char has_second_slash = 0;
            #pragma unroll
            for (unsigned char k = 1; k < path_pos; k++) {
              if (path_buf[k] == '.') has_dot = 1;
              if (path_buf[k] == '/' && k > 1) has_second_slash = 1;
            }
            if (has_dot && has_second_slash) {
              /* Reformat "/package.Service/Method" -> "package.Service:Method" */
              /* by replacing the final '/' with ':' */
              #pragma unroll
              for (unsigned char k = path_pos - 1; k > 0; k--) {
                if (path_buf[k] == '/') {
                  path_buf[k] = ':';
                  break;
                }
              }
              path_buf[path_pos] = '\0';
              *out_path_len = path_pos;
              path_found = 1;
              break;
            }
          }
          path_started = 0;
          path_pos = 0;
        } else {
          if (buf[i] >= 32 && buf[i] <= 126) /* printable ASCII */
            path_buf[path_pos++] = buf[i];
          else
            path_started = 0; /* non-printable: not a valid path */
        }
      }
    }
  }

  return proto;
}
/* Returns 1 if found and parsed, 0 otherwise.                            */
/* traceparent format: 00-<32_hex_trace_id>-<16_hex_span_id>-<2_hex_flags> */
static __always_inline int parse_traceparent(const unsigned char *buf,
                                              size_t buf_len,
                                              char trace_id[16],
                                              __u64 *parent_span_id) {
  /* Find "traceparent:" in the buffer (case-sensitive) */
  int found = 0;
  int header_start = 0;
  #pragma unroll
  for (int i = 0; i < 480; i++) {
    if (i + 13 >= (int)buf_len)
      break;
    if (buf[i] == 't' && buf[i+1] == 'r' && buf[i+2] == 'a' &&
        buf[i+3] == 'c' && buf[i+4] == 'e' && buf[i+5] == 'p' &&
        buf[i+6] == 'a' && buf[i+7] == 'r' && buf[i+8] == 'e' &&
        buf[i+9] == 'n' && buf[i+10] == 't' && buf[i+11] == ':' &&
        buf[i+12] == ' ') {
      header_start = i + 13; /* skip "traceparent: " */
      found = 1;
      break;
    }
  }
  if (!found)
    return 0;

  /* Expect value starting with "00-" (version + separator) */
  if (header_start + 2 >= (int)buf_len ||
      buf[header_start] != '0' || buf[header_start+1] != '0' ||
      buf[header_start+2] != '-')
    return 0;

  int pos = header_start + 3; /* Skip "00-" */

  /* Parse 32 hex chars of trace_id -> 16 bytes */
  if (pos + 32 >= (int)buf_len)
    return 0;
  #pragma unroll
  for (int i = 0; i < 16; i++) {
    int hex_pos = pos + (i * 2);
    unsigned char hi = hex_char_to_u8((char)buf[hex_pos]);
    unsigned char lo = hex_char_to_u8((char)buf[hex_pos + 1]);
    trace_id[i] = (hi << 4) | lo;
  }
  pos += 32;

  /* Expect "-" separator */
  if (pos >= (int)buf_len || buf[pos] != '-')
    return 0;
  pos++;

  /* Parse 16 hex chars of parent_span_id -> 8 bytes */
  if (pos + 16 >= (int)buf_len)
    return 0;
  __u64 parsed = 0;
  #pragma unroll
  for (int i = 0; i < 8; i++) {
    int hex_pos = pos + (i * 2);
    unsigned char hi = hex_char_to_u8((char)buf[hex_pos]);
    unsigned char lo = hex_char_to_u8((char)buf[hex_pos + 1]);
    parsed = (parsed << 8) | ((__u64)((hi << 4) | lo));
  }
  *parent_span_id = parsed;

  return 1;
}

SEC("kprobe/tcp_recvmsg")
int trace_tcp_recvmsg(struct pt_regs *ctx) {
  __u64 pid_tgid = bpf_get_current_pid_tgid();
  __u32 pid = pid_tgid >> 32;

  /* arg1 = struct sock *sk, arg2 = struct msghdr *msg */
  struct sock *sk = (struct sock *)PT_REGS_PARM1(ctx);
  struct msghdr *msg = (struct msghdr *)PT_REGS_PARM2(ctx);

  if (!sk || !msg)
    return 0;

  /* Read connection identity */
  __u32 source_ip = BPF_CORE_READ(sk, __sk_common.skc_rcv_saddr);
  __u32 dest_ip   = BPF_CORE_READ(sk, __sk_common.skc_daddr);
  __u16 dest_port = BPF_CORE_READ(sk, __sk_common.skc_dport);

  /* Peek at the first iovec's data (the TCP payload) */
  struct iovec *iov = BPF_CORE_READ(msg, msg_iter.__iov);
  if (!iov)
    return 0;

  /* Read first 512 bytes of payload — bounded for verifier */
  unsigned char peek[HTTP_PEEK_MAX];
  size_t iov_len = BPF_CORE_READ(iov, iov_len);
  size_t len = iov_len < HTTP_PEEK_MAX ? iov_len : HTTP_PEEK_MAX;
  if (len < 16) /* Too short to contain HTTP request/response line */
    return 0;

  if (bpf_probe_read_user(peek, len, BPF_CORE_READ(iov, iov_base)) < 0)
    return 0;

  /* ── Parse HTTP/1.x request line: "METHOD /path HTTP/1.x\r\n" ──────── */
  unsigned char method = 0; /* 0=unknown, 1=GET, 2=POST, 3=PUT, 4=DELETE */
  unsigned short http_status = 0;
  unsigned char is_response = 0;
  unsigned char path_len = 0;
  unsigned char path_start = 0;

  /* Detect HTTP response: "HTTP/1." at position 0 */
  if (peek[0] == 'H' && peek[1] == 'T' && peek[2] == 'T' && peek[3] == 'P' &&
      peek[4] == '/' && (peek[5] == '1' || peek[5] == '2')) {
    is_response = 1;
    /* Parse status code: "HTTP/1.x NNN " */
    if (peek[9] >= '0' && peek[9] <= '9') {
      http_status = (unsigned short)(peek[9] - '0') * 100;
      if (peek[10] >= '0' && peek[10] <= '9')
        http_status += (unsigned short)(peek[10] - '0') * 10;
      if (peek[11] >= '0' && peek[11] <= '9')
        http_status += (unsigned short)(peek[11] - '0');
    }
  } else {
    /* Detect HTTP request method */
    #pragma unroll
    for (int i = 0; i < 7; i++) {
      if (peek[i] == ' ') {
        path_start = (unsigned char)(i + 1);
        break;
      }
    }

    if (path_start > 0 && path_start < 8) {
      if (peek[0] == 'G' && peek[1] == 'E' && peek[2] == 'T')
        method = 1; /* GET */
      else if (peek[0] == 'P' && peek[1] == 'O' && peek[2] == 'S' && peek[3] == 'T')
        method = 2; /* POST */
      else if (peek[0] == 'P' && peek[1] == 'U' && peek[2] == 'T')
        method = 3; /* PUT */
      else if (peek[0] == 'D' && peek[1] == 'E' && peek[2] == 'L')
        method = 4; /* DELETE */
      else if (peek[0] == 'P' && peek[1] == 'A' && peek[2] == 'T')
        method = 5; /* PATCH */
      else if (peek[0] == 'H' && peek[1] == 'E' && peek[2] == 'A' && peek[3] == 'D')
        method = 6; /* HEAD */

      /* Find end of path (" HTTP/") */
      #pragma unroll
      for (int j = 0; j < 128; j++) {
        int idx = path_start + j;
        if (idx >= (int)len || idx >= path_start + 64)
          break;
        if (peek[idx] == ' ' || peek[idx] == '\r' || peek[idx] == '\n') {
          path_len = (unsigned char)j;
          break;
        }
      }
    }
  }

  /* ── Parse traceparent header for distributed tracing ──────────────── */
  char trace_id[16] = {};
  __u64 parent_span_id = 0;
  int has_trace = parse_traceparent(peek, len, trace_id, &parent_span_id);

  /* ── Detect protocol (HTTP/1.x, HTTP/2, gRPC) and extract path ──────── */
  char proto_path[GRPC_PATH_MAX] = {};
  unsigned char proto_path_len = 0;
  unsigned char protocol = detect_protocol(peek, len, is_response,
                                           proto_path, &proto_path_len);

  __u64 ts = bpf_ktime_get_ns();
  /* Generate span_id from connection context */
  __u64 span_id = make_span_id(pid, (__u32)pid_tgid, ts, dest_ip, dest_port);

  /* ── Emit event ─────────────────────────────────────────────────────── */
  struct network_event event = {};
  event.timestamp_ns = ts;
  event.pid = pid;
  event.tgid = (__u32)pid_tgid;
  event.dest_ip = dest_ip;
  event.source_ip = source_ip;
  event.dest_port = dest_port;
  event.status = is_response ? 6 : 5;
  event.protocol = protocol;
  event.path_len = proto_path_len;
  /* bytes: HTTP status encoding — uses HTTP path_len (not overwritten by gRPC) */
  event.bytes = ((__u64)http_status << 16) | ((__u64)method << 8) | (__u64)path_len;
  bpf_get_current_comm(event.comm, sizeof(event.comm));
  if (has_trace) {
    __builtin_memcpy(event.trace_id, trace_id, 16);
    event.span_id = span_id;
    event.parent_span_id = parent_span_id;
  }
  if (proto_path_len > 0) {
    __builtin_memcpy(event.path, proto_path,
                     proto_path_len < 32 ? proto_path_len : 32);
  }

  emit_event(&event, false); /* STANDARD */

  return 0;
}

char LICENSE[] SEC("license") = "GPL";

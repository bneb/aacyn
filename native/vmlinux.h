/* vmlinux.h — CANONICAL header for aacyn eBPF BPF programs (CO-RE)
 *
 * This is a hand-crafted subset of the full vmlinux.h (which is typically
 * 100k+ lines generated via bpftool). We only define the kernel types
 * that our BPF programs actually reference.
 *
 * USED BY:   aacyn_probes.bpf.c  and  aacyn_auto.bpf.c  (via #include "vmlinux.h")
 * TARGET:    Linux eBPF builds only (Makefile EBPF=1 on Linux)
 * FEATURES:  CO-RE (preserve_access_index), dual-arch pt_regs (x86 + ARM64),
 *            full socket introspection chain (task_struct → socket → sock)
 * CANONICAL: This is the active, maintained variant.
 *            See vmlinux_stub.h for the CI/Docker-only alternative.
 *
 * CO-RE compatible — libbpf performs BTF relocation at load time
 * against the running kernel's actual type layout.
 *
 * Generate the full version from running kernel BTF:
 *   bpftool btf dump file /sys/kernel/btf/vmlinux format c > vmlinux.h
 */

#ifndef __VMLINUX_H__
#define __VMLINUX_H__

/* ─── Basic kernel types ─────────────────────────────────────────────────── */

typedef unsigned char  __u8;
typedef unsigned short __u16;
typedef unsigned int   __u32;
typedef unsigned long long __u64;
typedef signed char    __s8;
typedef short          __s16;
typedef int            __s32;
typedef long long      __s64;
typedef long           __kernel_long_t;
typedef unsigned long  __kernel_ulong_t;
typedef __u32          __be32;
typedef __u16          __be16;

#ifndef __SIZE_TYPE__
#define __SIZE_TYPE__ unsigned long
#endif
typedef __SIZE_TYPE__ size_t;

/* Kernel checksum types used in BPF helper definitions */
typedef __u32 __wsum;

/* Forward declarations for BPF helper function signatures.
 * We don't use these directly but bpf_helper_defs.h references them. */
struct __sk_buff;
struct xdp_md;
struct bpf_perf_event_data;
struct bpf_sock;
struct bpf_sock_addr;
struct bpf_sock_ops;
struct bpf_cgroup_dev_ctx;
struct bpf_sysctl;
struct bpf_sockopt;
struct sk_msg_md;
struct bpf_map;

/* ─── BPF enum constants ─────────────────────────────────────────────────── */
/* These are typically in linux/bpf.h but vmlinux.h must provide them.      */

enum bpf_map_type {
    BPF_MAP_TYPE_UNSPEC          = 0,
    BPF_MAP_TYPE_HASH            = 1,
    BPF_MAP_TYPE_ARRAY           = 2,
    BPF_MAP_TYPE_PROG_ARRAY      = 3,
    BPF_MAP_TYPE_PERF_EVENT_ARRAY = 4,
    BPF_MAP_TYPE_PERCPU_HASH     = 5,
    BPF_MAP_TYPE_PERCPU_ARRAY    = 6,
    BPF_MAP_TYPE_STACK_TRACE     = 7,
    BPF_MAP_TYPE_CGROUP_ARRAY    = 8,
    BPF_MAP_TYPE_LRU_HASH        = 9,
    BPF_MAP_TYPE_LRU_PERCPU_HASH = 10,
    BPF_MAP_TYPE_LPM_TRIE        = 11,
    BPF_MAP_TYPE_ARRAY_OF_MAPS   = 12,
    BPF_MAP_TYPE_HASH_OF_MAPS    = 13,
    BPF_MAP_TYPE_DEVMAP          = 14,
    BPF_MAP_TYPE_SOCKMAP          = 15,
    BPF_MAP_TYPE_CPUMAP          = 16,
    BPF_MAP_TYPE_XSKMAP          = 17,
    BPF_MAP_TYPE_SOCKHASH        = 18,
    BPF_MAP_TYPE_CGROUP_STORAGE  = 19,
    BPF_MAP_TYPE_REUSEPORT_SOCKARRAY = 20,
    BPF_MAP_TYPE_PERCPU_CGROUP_STORAGE = 21,
    BPF_MAP_TYPE_QUEUE           = 22,
    BPF_MAP_TYPE_STACK           = 23,
    BPF_MAP_TYPE_SK_STORAGE      = 24,
    BPF_MAP_TYPE_DEVMAP_HASH     = 25,
    BPF_MAP_TYPE_STRUCT_OPS      = 26,
    BPF_MAP_TYPE_RINGBUF         = 27,
    BPF_MAP_TYPE_INODE_STORAGE   = 28,
    BPF_MAP_TYPE_TASK_STORAGE    = 29,
    BPF_MAP_TYPE_BLOOM_FILTER    = 30,
};

/* BPF_ANY, BPF_NOEXIST, BPF_EXIST — map update flags */
#define BPF_ANY     0
#define BPF_NOEXIST 1
#define BPF_EXIST   2

/* ─── Tracepoint context structures ──────────────────────────────────────── */

struct trace_event_raw_sys_enter {
    __u64 unused;
    __s32 __syscall_nr;
    __u32 pad;
    unsigned long args[6];
};

struct trace_event_raw_sys_exit {
    __u64 unused;
    __s32 __syscall_nr;
    __u32 pad;
    long ret;
};

/* ─── pt_regs — kprobe context ───────────────────────────────────────────── */
/* libbpf's bpf_tracing.h on ARM64 uses 'struct user_pt_regs', not          */
/* 'struct pt_regs'. We must define both to satisfy the macros.             */

#if defined(__TARGET_ARCH_arm64) || defined(__aarch64__)

struct user_pt_regs {
    __u64 regs[31];
    __u64 sp;
    __u64 pc;
    __u64 pstate;
};

struct pt_regs {
    struct user_pt_regs user_regs;
    __u64 orig_x0;
    __s32 syscallno;
    __u32 unused2;
    __u64 sdei_ttbr1;
    __u64 pmr_save;
    __u64 stackframe[2];
    __u64 lockdep_hardirqs;
    __u64 exit_rcu;
};

#elif defined(__TARGET_ARCH_x86) || defined(__x86_64__)

struct pt_regs {
    __u64 r15, r14, r13, r12;
    __u64 bp, bx;
    __u64 r11, r10, r9, r8;
    __u64 ax, cx, dx, si, di;
    __u64 orig_ax;
    __u64 ip, cs, flags, sp, ss;
};

#else
#error "Unsupported architecture for pt_regs"
#endif

/* ─── Socket structures ──────────────────────────────────────────────────── */

struct in_addr {
    __be32 s_addr;
};

struct sockaddr_in {
    __u16 sin_family;
    __be16 sin_port;
    struct in_addr sin_addr;
    __u8 __pad[8];
};

/* ─── CO-RE Struct Definitions for Socket Introspection ──────────────────── */
/* Minimal definitions — libbpf resolves actual offsets from running kernel   */
/* BTF at load time. Only the fields we access via BPF_CORE_READ are needed. */

struct sock_common {
    __u32 skc_rcv_saddr;  /* Local IPv4 address (source) */
    __u32 skc_daddr;      /* Remote IPv4 address (dest) */
    __u16 skc_dport;      /* Remote port (network byte order) */
} __attribute__((preserve_access_index));

struct sock {
    struct sock_common __sk_common;
} __attribute__((preserve_access_index));

struct socket {
    struct sock *sk;
} __attribute__((preserve_access_index));

struct file {
    void *private_data;   /* Points to struct socket for socket fds */
} __attribute__((preserve_access_index));

struct fdtable {
    struct file **fd;     /* Array of file pointers */
} __attribute__((preserve_access_index));

struct files_struct {
    struct fdtable *fdt;
} __attribute__((preserve_access_index));

struct task_struct {
    struct files_struct *files;
} __attribute__((preserve_access_index));

#endif /* __VMLINUX_H__ */

/*
 * vmlinux_stub.h — CI/Docker BUILD VALIDATION STUB (non-canonical)
 *
 * PURPOSE:  Lightweight alternative to the canonical vmlinux.h for use in
 *           CI pipelines or Docker builds where full kernel BTF is unavailable
 *           (/sys/kernel/btf/vmlinux does not exist).
 *
 * NOT INCLUDED by any source file by default. The BPF .bpf.c files always
 * include "vmlinux.h" (the canonical variant). If you need to compile BPF
 * programs in an environment without kernel BTF, temporarily copy this stub
 * over vmlinux.h, or adjust the Makefile to add an -include path.
 *
 * LIMITATIONS (compared to canonical vmlinux.h):
 *   - No CO-RE (preserve_access_index) attributes
 *   - No ARM64 pt_regs support (x86_64 only)
 *   - No source IP introspection (skc_rcv_saddr missing from sock)
 *   - No task_struct/files_struct/fdtable/file chain
 *
 * On production build hosts, generate the FULL vmlinux.h via:
 *   bpftool btf dump file /sys/kernel/btf/vmlinux format c > vmlinux.h
 *
 * WARNING: vmlinux_stub.h and vmlinux.h share the include guard
 *          __VMLINUX_H__ and MUST NOT be included together.
 */
#ifndef __VMLINUX_H__
#define __VMLINUX_H__

/* ─── Primitive Types ────────────────────────────────────────────────────── */

typedef unsigned char __u8;
typedef unsigned short __u16;
typedef unsigned int __u32;
typedef unsigned long long __u64;
typedef signed char __s8;
typedef signed short __s16;
typedef signed int __s32;
typedef signed long long __s64;

typedef __u16 __be16;
typedef __u32 __be32;
typedef __u64 __be64;
typedef __u32 __wsum;
typedef __u32 pid_t;
typedef unsigned long size_t;

/* ─── BPF Map Types ──────────────────────────────────────────────────────── */

enum bpf_map_type {
  BPF_MAP_TYPE_UNSPEC = 0,
  BPF_MAP_TYPE_HASH = 1,
  BPF_MAP_TYPE_ARRAY = 2,
  BPF_MAP_TYPE_PROG_ARRAY = 3,
  BPF_MAP_TYPE_PERF_EVENT_ARRAY = 4,
  BPF_MAP_TYPE_RINGBUF = 27,
};

/* ─── BPF Constants ──────────────────────────────────────────────────────── */

enum {
  BPF_ANY = 0,
  BPF_NOEXIST = 1,
  BPF_EXIST = 2,
};

#define AF_INET 2

/* ─── Socket Structures ──────────────────────────────────────────────────── */

struct sockaddr {
  __u16 sa_family;
  char sa_data[14];
};

struct sockaddr_in {
  __u16 sin_family;
  __be16 sin_port;
  struct {
    __be32 s_addr;
  } sin_addr;
  __u8 __pad[8];
};

struct sock {
  struct {
    __be32 skc_daddr;
    __be16 skc_dport;
  } __sk_common;
};

struct msghdr {
  void *msg_name;
  int msg_namelen;
};

/* ─── Tracepoint Structures ──────────────────────────────────────────────── */

struct trace_event_raw_sys_enter {
  __u64 unused;
  __s32 id;
  unsigned long args[6];
};

struct trace_event_raw_sys_exit {
  __u64 unused;
  __s32 id;
  long ret;
};

/* ─── x86_64 pt_regs (for kprobes) ──────────────────────────────────────── */

struct pt_regs {
  unsigned long r15;
  unsigned long r14;
  unsigned long r13;
  unsigned long r12;
  unsigned long bp;
  unsigned long bx;
  unsigned long r11;
  unsigned long r10;
  unsigned long r9;
  unsigned long r8;
  unsigned long ax;
  unsigned long cx;
  unsigned long dx;
  unsigned long si;
  unsigned long di;
  unsigned long orig_ax;
  unsigned long ip;
  unsigned long cs;
  unsigned long flags;
  unsigned long sp;
  unsigned long ss;
};

/* ─── sk_buff (minimal for bpf_csum_diff) ────────────────────────────────── */

struct __sk_buff {
  __u32 len;
  __u32 pkt_type;
  __u32 mark;
  __u32 queue_mapping;
  __u32 protocol;
  __u32 vlan_present;
  __u32 vlan_tci;
  __u32 vlan_proto;
  __u32 priority;
  __u32 ingress_ifindex;
  __u32 ifindex;
  __u32 tc_index;
  __u32 cb[5];
  __u32 hash;
  __u32 tc_classid;
  __u32 data;
  __u32 data_end;
  __u32 napi_id;
};

#endif /* __VMLINUX_H__ */

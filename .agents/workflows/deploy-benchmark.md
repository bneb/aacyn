---
description: Deploy aacyn v0.5.0 to Minisforum UM890 Pro (AMD Ryzen 9) and run the binary siege benchmark
---

# aacyn Node Deployment — Minisforum UM890 Pro

## Prerequisites
- Minisforum UM890 Pro (AMD Ryzen 9 8945HS)
- Samsung Type-C USB with Ubuntu Server 24.04 ISO
- Ethernet cable (direct to router — no Wi-Fi)
- Your Mac with the aacyn codebase at `~/projects/aacyn`

---

## Phase 1: Exorcising Windows

1. Plug in power, monitor, keyboard, and **ethernet cable**
2. Insert the Ubuntu Server USB
3. Power on, **mash F7** (or DEL) for BIOS/Boot Menu
4. Select the Samsung USB drive
5. Choose **Ubuntu Server (minimized)** — no GUI
6. **Critical**: On the Network/SSH screen, press **Spacebar** to enable **Install OpenSSH server**
7. Wipe the entire 1TB NVMe. Let it install
8. Remove USB, reboot

## Phase 2: SSH In

Find the IP (router admin page, or log in locally and run `ip a`):

```bash
ssh ubuntu@<MINISFORUM_IP>
```

## Phase 3: Weaponization

// turbo-all

Paste this into the SSH session:

```bash
cat << 'SCRIPT' > weaponize.sh
#!/bin/bash
set -e
echo "[*] Initiating aacyn Node Bootstrap (AMD x86_64 Edition)..."

# 1. Core Toolchain
sudo apt-get update -y
sudo apt-get install -y build-essential clang llvm libbpf-dev libelf-dev zlib1g-dev \
    linux-headers-$(uname -r) linux-tools-$(uname -r) linux-tools-common \
    cpufrequtils git curl unzip jq

# 2. Lock CPU Governor to Max Performance
sudo cpufreq-set -r -g performance
echo "[+] Ryzen 9 locked to maximum clock speed."

# 3. Kernel Tuning for k6 Siege
cat <<SYSCTL | sudo tee /etc/sysctl.d/99-aacyn-siege.conf
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_tw_reuse = 1
vm.max_map_count = 262144
vm.swappiness = 10
SYSCTL
sudo sysctl --system > /dev/null

# 4. Install Bun & Just
curl -fsSL https://bun.sh/install | bash
curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh | bash -s -- --to ~/bin
export PATH="$HOME/.bun/bin:$HOME/bin:$PATH"

# 5. Install k6
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
    --keyserver hkp://keyserver.ubuntu.com:80 \
    --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
    | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update -y && sudo apt-get install -y k6

echo "[+] X86 SOVEREIGN NODE WEAPONIZED."
SCRIPT

bash weaponize.sh
source ~/.bashrc
```

> **NOTE**: The script now installs `libelf-dev`, `zlib1g-dev`, and `linux-tools-$(uname -r)` (not just `linux-tools-common`). These are required for libbpf linking and for `bpftool` to generate `vmlinux.h` from the live kernel BTF.

## Phase 4: Transfer & Build

**From your Mac** (new terminal tab):

```bash
rsync -avz --exclude node_modules --exclude .git --exclude .next --exclude build \
    ~/projects/aacyn/ ubuntu@<MINISFORUM_IP>:~/aacyn/
```

> **NOTE**: Trailing slash on source (`aacyn/`) ensures contents go into `~/aacyn/` on the target, not `~/aacyn/aacyn/`.

**Back in the SSH session:**

```bash
cd ~/aacyn

# Generate vmlinux.h from live kernel BTF (NOT the stub)
sudo bpftool btf dump file /sys/kernel/btf/vmlinux format c > native/vmlinux.h
echo "[+] vmlinux.h generated from live kernel BTF ($(wc -l < native/vmlinux.h) lines)"

# Install TS dependencies
cd ts && bun install && cd ..

# Build native library + eBPF probes
just build-native
make -C native EBPF=1
```

You should see:
```
║  Platform: Linux/x86_64
║  CFLAGS:   -O3 ... -mavx512f -mavx512bw -mavx512vl
║  eBPF:     ../build/aacyn_probes.bpf.o
```

## Phase 5: Generate Benchmark Payload

```bash
cd ~/aacyn
just build-payload
```

## Phase 6: Ignition

**Tab 1 — Start the API (as root for eBPF CAP_BPF):**

```bash
cd ~/aacyn/ts/apps/api
sudo ~/.bun/bin/bun run src/index.ts
```

Look for:
```
[🛡️ libaacyn] Native store initialized: 16,000,000 capacity, 198.4MB mmap'd
[🛡️ aacyn] Native FFI store active — V8 GC bypassed
```

**Tab 2 — Unleash the Binary Siege:**

```bash
cd ~/aacyn
just benchmark-binary
```

## Phase 7: Record the Numbers

Copy the exact output of the SOVEREIGN BINARY SIEGE REPORT:
- **Total Requests**
- **Events Ingested**
- **p95 latency (ms)**
- **p99 latency (ms)**
- **Max latency (ms)**
- **Error rate**

These go directly into the Founders Fund pitch deck.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `bpftool: command not found` | `sudo apt install linux-tools-$(uname -r)` |
| `Failed to load BPF programs (CAP_BPF)` | Run API with `sudo` |
| `vmlinux.h: No such file` | `sudo bpftool btf dump file /sys/kernel/btf/vmlinux format c > native/vmlinux.h` |
| `libaacyn.so: cannot open shared object` | Run `just build-native` first |
| k6 connection refused | Ensure API is running on port 3001 |

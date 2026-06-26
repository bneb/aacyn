---
path: "charts/**, Dockerfile*, docker-compose*.yml, docker-demo/**"
---

# Kubernetes & Container Rules

## Helm Chart Standards
- All templates in `charts/aacyn/templates/`.
- `values.yaml` must document every configurable value with comments.
- Use `helm lint` before committing chart changes.
- DaemonSet must include: privileged security context, hostPID, `/sys/kernel/debug` mount, tolerations for all taints.
- Aggregator Deployment must include: health probes, resource limits, pod anti-affinity (preferred).

## Docker Standards
- Multi-stage builds — separate build stage from runtime stage.
- Runtime image ≤ 50MB (Alpine-based, binary + libaacyn.so + eBPF .o files).
- Never run as root in the final stage unless eBPF requires it (it does — document why).
- Use specific base image tags, not `:latest`.
- `.dockerignore` must exclude `node_modules`, `.env*`, build artifacts.

## eBPF in Containers
- Container must run with `--privileged` or `CAP_BPF` + `CAP_SYS_ADMIN` + `CAP_NET_ADMIN`.
- Mount `/sys/kernel/debug` and `/sys/kernel/tracing` for BTF and tracepoints.
- `hostPID: true` required for service auto-discovery (reads `/proc`).
- Kernel version check at startup — fail fast with a clear message if kernel < 5.15.

## Testing
- Test Helm chart on Kind cluster in CI.
- `helm test aacyn` must verify: DaemonSet pods running, eBPF probes attached, topology data flowing.
- Docker demo must work with `docker compose up` — test on both ARM64 and x86_64.

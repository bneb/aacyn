# Security Policy

## Reporting a Vulnerability

Report security vulnerabilities by filing a **GitHub Security Advisory** at https://github.com/aacyn/aacyn/security/advisories. GitHub Security Advisories support encryption for sensitive reports.

Do not file public GitHub issues for vulnerabilities. You will receive an acknowledgement within 48 hours and a timeline for a fix within 5 business days.

## Supported Versions

Only the latest major/minor release receives security patches. There is no LTS channel.

- v1.0.0-dev (pre-release) — patches are applied to main and released in the next stable cut.

## Security Model

### Privilege Requirements

aacyn runs as a Kubernetes DaemonSet with the following Linux capabilities:

- `CAP_BPF`, `CAP_SYS_ADMIN`, `CAP_NET_ADMIN` — required to load and attach eBPF programs
- `hostPID: true` — required to read `/proc` for service auto-discovery
- Mounted `/sys/kernel/debug` and `/sys/kernel/tracing` — required for BTF and tracepoints

These are inherent to eBPF-based observability and cannot be eliminated. The DaemonSet should be deployed on dedicated node pools where workload isolation is acceptable.

### API Authentication

The API server listens on port 3001. Authentication is optional and controlled by the `AACYN_API_KEY` environment variable:

- **Key set**: All requests (except `/health`) require the `Authorization: Bearer <key>` header.
- **Key unset**: The API server allows all requests. Do not expose it to untrusted networks.

API keys are compared using a constant-time equality check. Key rotation requires a restart.

### Network Boundary

aacyn does not initiate egress by default. Optional forwarder plugins (Datadog, Splunk) can be enabled via configuration — they are the only code paths that establish outbound connections.

The API server should be deployed behind a Kubernetes `NetworkPolicy` that restricts ingress to trusted clients and egress to only the configured forwarders.

## Scope

The following components are in scope for security reports:

- API server (`ts/apps/api/`)
- eBPF probes (`native/*.bpf.c`)
- Native C columnar store (`native/libaacyn.c`, `native/libaacyn.h`)
- Grafana data source plugin (`grafana-plugin/`)
- Helm chart (`charts/aacyn/`)

## Out of Scope

The following are explicitly out of scope:

- Docker demo (`docker-demo/`) — development/test use only
- Benchmark suite (`native/bench/`, `ts/packages/bench/`) — not deployed in production

## Disclosure Policy

- **90-day responsible disclosure**: We commit to releasing a fix within 90 days of a confirmed report. The reporter is credited in the release notes unless they request anonymity.
- **Coordinated disclosure**: We prefer to coordinate public disclosure timing with the reporter.
- **Bug bounty**: aacyn does not currently operate a paid bug bounty program.

## Dependency Security

- Dependency updates are managed through GitHub's dependency review features.
- Pull requests that introduce new dependencies require maintainer review for supply chain risk.

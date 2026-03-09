# aacyn Configuration Reference

> Every environment variable that aacyn reads, what it does, and what happens if you don't set it.

---

## Quick Reference

| Variable | Required | Default | Component |
|----------|----------|---------|-----------|
| `PORT` | No | `3001` | API Server |
| `AACYN_API_KEY` | Yes (production) | — | API Server |
| `NODE_ENV` | No | `development` | Runtime |
| `LOG_LEVEL` | No | `debug` (dev) / `info` (prod) | Runtime |
| `AACYN_MODE` | No | `standalone` | Aggregator |
| `AACYN_AGGREGATOR_URL` | Depends | — | Aggregator |
| `AACYN_BPF_OBJ` | No | Auto-detected | eBPF |
| `AACYN_CONFIG` | No | `aacyn.toml` | Filter Rules |
| `LIBAACYN_PATH` | No | Auto-detected | Native Engine |
| `DATADOG_API_KEY` | No | — | Forwarder |
| `DATADOG_SITE` | No | `datadoghq.com` | Forwarder |
| `SPLUNK_HEC_URL` | No | — | Forwarder |
| `SPLUNK_HEC_TOKEN` | No | — | Forwarder |
| `ALERT_WEBHOOK_URL` | No | — | Alerting |
| `SLACK_WEBHOOK_URL` | No | — | Alerting |
| `AACYN_ARCHIVER_STATE` | No | `/var/lib/aacyn/archiver_state.json` | Archiver |
| `AACYN_ARCHIVER_CHUNK_SIZE` | No | `1000000` | Archiver |
| `AACYN_ARCHIVER_INTERVAL_MS` | No | `60000` | Archiver |
| `S3_ENDPOINT` | Depends | — | Archiver |
| `S3_REGION` | No | `auto` | Archiver |
| `S3_ACCESS_KEY_ID` | Depends | — | Archiver |
| `S3_SECRET_ACCESS_KEY` | Depends | — | Archiver |
| `S3_BUCKET` | Depends | — | Archiver |

---

## API Server

### `PORT`

The TCP port the aacyn API server listens on.

| | |
|---|---|
| **Default** | `3001` |
| **Example** | `PORT=8080` |
| **If unset** | Listens on port 3001 |

> **Tip:** If you're running behind a reverse proxy (nginx, Caddy), keep the default and proxy from 443 → 3001.

### `AACYN_API_KEY`

Bearer-token API key for authenticating requests to all non-health routes.

| | |
|---|---|
| **Default** | None (auth disabled in development) |
| **Example** | `AACYN_API_KEY=my-secret-key` (minimum 32 characters) |
| **If unset in production** | Server logs a fatal error and returns 500 on all authenticated routes |
| **If unset in development** | Auth is disabled — all requests pass through without a token |

> **Security:** In production this is **required**. Set it to a random string of 32+ characters. The key is compared using `crypto.timingSafeEqual` to prevent timing attacks. Bearer tokens are expected in the `Authorization` header: `Authorization: Bearer <key>`.

### `NODE_ENV`

Controls runtime behavior including authentication enforcement. Also read by the logger (via pino integration).

| | |
|---|---|
| **Default** | `development` |
| **Values** | `development`, `production` |
| **Example** | `NODE_ENV=production` |
| **If unset** | Defaults to `development` — auth is permissive |

> In `production` mode the server **requires** `AACYN_API_KEY` to be set and will refuse requests that don't carry a valid Bearer token.

### `LOG_LEVEL`

Sets the logging verbosity.

| | |
|---|---|
| **Default** | `debug` in development, `info` in production |
| **Values** | `debug`, `info`, `warn`, `error` |
| **Example** | `LOG_LEVEL=warn` |
| **If unset** | Uses the environment-appropriate default |

---

## eBPF

### `AACYN_BPF_OBJ`

Absolute path to the compiled eBPF probe object file.

| | |
|---|---|
| **Default** | `<project_root>/build/aacyn_probes.bpf.o` (auto-detected) |
| **Example** | `AACYN_BPF_OBJ=/opt/aacyn/build/aacyn_probes.bpf.o` |
| **If unset** | Searches for the BPF object relative to the project root |
| **If file not found** | eBPF is silently disabled; server runs normally |

> **Requirements for eBPF:** Linux kernel 5.8+, `CAP_BPF` (run as root), and `libbpf-dev` installed. See `docs/ebpf.md` for setup.

---

## Filter Rules

### `AACYN_CONFIG`

Path to the TOML configuration file for declarative filter rules.

| | |
|---|---|
| **Default** | `aacyn.toml` |
| **Example** | `AACYN_CONFIG=/etc/aacyn/config.toml` |
| **If unset** | Looks for `aacyn.toml` in the current working directory |
| **If file not found** | Filter rules are silently skipped; all events are accepted |

> Filter rules are compiled from `AACYN_CONFIG` into a packed binary format and passed to the C store engine. See `aacyn.toml` (project root) for the TOML schema.

---

## Native Engine

### `LIBAACYN_PATH`

Override the filesystem path to the native C shared library (`libaacyn.so` on Linux, `libaacyn.dylib` on macOS).

| | |
|---|---|
| **Default** | Auto-detected: co-located with the binary first, then `build/libaacyn.{so,dylib}` relative to the project root |
| **Example** | `LIBAACYN_PATH=/usr/local/lib/libaacyn.so` |
| **If unset** | Searches common locations automatically |
| **If file not found** | Falls back to the V8 MapStore (no SIMD, no eBPF, no archiver) |

> Set this when you have installed the native library to a non-standard path, or when running a compiled binary (`bun build --compile`) without the library co-located.

---

## Aggregator Mode

### `AACYN_MODE`

Controls whether this API instance acts as a standalone server, an aggregator, a node, or both.

| | |
|---|---|
| **Default** | `standalone` |
| **Values** | `standalone`, `aggregator`, `node`, `full` |
| **CLI override** | `aacyn server --mode aggregator` |
| **If unset** | Runs in standalone mode (all features local, no cluster aggregation) |

In a multi-node deployment:
- **`standalone`** (default): Single-node mode. No cluster topology merging.
- **`aggregator`**: Accepts topology pushes from remote nodes and merges them into a cluster-wide view. Exposes the push endpoint at `POST /v1/aggregator/push` and the merged view at `GET /v1/aggregator/topology`.
- **`node`**: Periodically pushes local topology data to a remote aggregator. Requires `AACYN_AGGREGATOR_URL`.
- **`full`**: Both a local aggregator and a node client.

### `AACYN_AGGREGATOR_URL`

The URL of the remote aggregator instance when running in `node` or `full` mode.

| | |
|---|---|
| **Default** | None |
| **Example** | `AACYN_AGGREGATOR_URL=http://aggregator:3001` |
| **If unset** | Node push is disabled |
| **Required** | When `AACYN_MODE` is `node` or `full` |

---

## Forwarders

aacyn can forward telemetry to external observability platforms in real time.

### `DATADOG_API_KEY` & `DATADOG_SITE`

Forward metrics to Datadog.

| | |
|---|---|
| **Default** | `DATADOG_SITE`: `datadoghq.com` |
| **Example** | `DATADOG_API_KEY=abc123…` |
| **If `DATADOG_API_KEY` is unset** | Datadog forwarding is disabled |
| **If `DATADOG_SITE` is unset** | Uses `datadoghq.com` (US1) |

> `DATADOG_SITE` should match your Datadog region (e.g. `datadoghq.eu` for EU, `ddog-gov.com` for US Gov). Metrics are pushed to the Datadog Metrics v2 API at `api.{site}`.

### `SPLUNK_HEC_URL` & `SPLUNK_HEC_TOKEN`

Forward events to Splunk via the HTTP Event Collector (HEC).

| | |
|---|---|
| **Default** | None |
| **Example** | `SPLUNK_HEC_URL=https://splunk.example.com:8088/services/collector/event` |
| **If unset** (either) | Splunk forwarding is disabled |
| **Format** | `SPLUNK_HEC_TOKEN`: UUID-style hex token assigned by your Splunk HEC endpoint |

> Both `SPLUNK_HEC_URL` and `SPLUNK_HEC_TOKEN` must be set for Splunk forwarding to activate. Events are posted as JSON to the HEC endpoint.

---

## Alerting

### `ALERT_WEBHOOK_URL`

Generic webhook URL for alert notifications. Compatible with any JSON-capable webhook receiver.

| | |
|---|---|
| **Default** | None |
| **Example** | `ALERT_WEBHOOK_URL=https://hooks.example.com/alerts` |
| **If unset** | Alert notifications are only printed to stdout |

### `SLACK_WEBHOOK_URL`

Slack-compatible webhook URL for alert notifications.

| | |
|---|---|
| **Default** | None |
| **Example** | `SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T00/B000/xxx` |
| **If unset** | Slack notifications are disabled |

> Alerts are evaluated every 30 seconds against the current topology. Both `ALERT_WEBHOOK_URL` and `SLACK_WEBHOOK_URL` can be set simultaneously — alerts are sent to all configured outputs.

---

## Cold Storage Archiver

The archiver extracts raw columnar data from the in-memory ring buffer, compresses it with zstd, and uploads to S3-compatible object storage (Cloudflare R2, MinIO, etc.).

### `AACYN_ARCHIVER_STATE`

Filesystem path for the archiver's persistent state file.

| | |
|---|---|
| **Default** | `/var/lib/aacyn/archiver_state.json` |
| **Example** | `AACYN_ARCHIVER_STATE=/data/aacyn/archiver_state.json` |
| **If unset** | Uses the default path |

> State is written to disk after every successful upload so the archiver can resume across restarts.

### `AACYN_ARCHIVER_CHUNK_SIZE`

Number of events to extract per archive chunk.

| | |
|---|---|
| **Default** | `1000000` |
| **Example** | `AACYN_ARCHIVER_CHUNK_SIZE=500000` |
| **If unset** | 1,000,000 events per chunk |

### `AACYN_ARCHIVER_INTERVAL_MS`

How often (in milliseconds) the archiver polls for new data.

| | |
|---|---|
| **Default** | `60000` |
| **Example** | `AACYN_ARCHIVER_INTERVAL_MS=300000` |
| **If unset** | Polls every 60 seconds |

### `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`

S3-compatible object storage credentials for archive uploads.

| | |
|---|---|
| **`S3_ENDPOINT`** | Required. The S3-compatible endpoint URL (e.g. `https://<account>.r2.cloudflarestorage.com` for R2, `https://minio.example.com` for MinIO). |
| **`S3_REGION`** | Optional. Default `auto`. Set to your S3 region (e.g. `us-east-1`) if required by your provider. |
| **`S3_ACCESS_KEY_ID`** | Required if archiving is desired. S3 access key. |
| **`S3_SECRET_ACCESS_KEY`** | Required if archiving is desired. S3 secret key. |
| **`S3_BUCKET`** | Required if archiving is desired. Bucket name for archive objects. |

> The archiver starts silently and logs an informational message when S3 credentials are missing — archive uploads are skipped until all required variables are set. Archives are compressed with zstd and named `aacyn_archive_{firstTs}_to_{lastTs}.bin.zst`.

## Environment File Hierarchy

aacyn uses three environment files, each for a different context:

```
.env.production   → Real secrets for deployed appliance (NEVER committed)
.env.local        → Local development defaults (gitignored)
.env.test         → Deterministic values for bun test (committed)
```

Load with: `source .env.production && bun run src/index.ts`

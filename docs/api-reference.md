# aacyn API Reference

> **Base URL:** `http://<your-appliance>:3001`
>
> All endpoints accept and return JSON unless otherwise noted. All timestamps are Unix epoch milliseconds unless marked `Ns` (nanoseconds).

---

## Health

### `GET /health`

Returns the current health status of the aacyn appliance. Use this as your load balancer health check endpoint.

**Request:** No body required.

**Response (200):**
```json
{
  "status": "ok",
  "version": "1.0.0-dev",
  "uptime": 86400000
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"ok"` \| `"degraded"` \| `"down"` | Current system health |
| `version` | string | Semantic version of the running appliance |
| `uptime` | number | Milliseconds since server start |

> **When to use:** Call this from your monitoring system every 30s. If `status` is not `"ok"`, page on-call.

---

## Ingestion

aacyn has two ingestion endpoints. Use **JSON batch** for simplicity or **binary** for maximum throughput.

### `POST /ingest/batch` — JSON Batch Ingestion

Accepts an array of RED (Rate/Error/Duration) metric events. This is the recommended starting point for most integrations.

**Request:**
```json
{
  "events": [
    {
      "traceId": "abc-123",
      "service": "payment-api",
      "durationMs": 42.5,
      "isError": false,
      "timestamp": 1710000000000
    }
  ]
}
```

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `traceId` | string | Yes | Non-empty | Unique identifier for the trace/request |
| `service` | string | Yes | Non-empty | Name of the originating service |
| `durationMs` | number | Yes | ≥ 0 | Request duration in milliseconds |
| `isError` | boolean | Yes | — | Whether this request resulted in an error |
| `timestamp` | number | Yes | > 0 | Unix epoch milliseconds |

**Response (202 Accepted):**
```json
{
  "accepted": 1,
  "timestamp": 1710000002000
}
```

| Field | Type | Description |
|-------|------|-------------|
| `accepted` | number | Number of events written to the columnar store |
| `timestamp` | number | Server timestamp at time of acceptance |

**Error Responses:**

| Status | Cause | Fix |
|--------|-------|-----|
| 422 | Schema validation failure | Check that all 5 required fields are present and correctly typed |
| 500 | Internal store error | Check server logs; the native store may have reached capacity |

> **Performance:** JSON batch ingestion sustains ~314K events/sec. For higher throughput, use binary ingestion.

---

### `POST /ingest/binary` — Binary FlatBuffer Ingestion

Accepts a raw FlatBuffer binary payload for zero-parse, zero-copy ingestion. This is the high-performance path.

**Request:**
```
Content-Type: application/octet-stream
Body: Raw FlatBuffer binary (TelemetryBatch schema)
```

**Response (202 Accepted):**
```json
{
  "accepted": 100,
  "timestamp": 1710000002000,
  "mode": "binary"
}
```

**Error Responses:**

| Status | Cause | Fix |
|--------|-------|-----|
| 400 | Buffer too small (< 8 bytes) | Ensure payload meets minimum size |
| 501 | Native store not available | Run `just build-native` to compile libaacyn |

> **Performance:** Binary ingestion sustains 5.09M events/sec with 16ms p99 latency. See `docs/binary-protocol.md` for the FlatBuffer schema and payload generation.

---

### `POST /v1/events` — Telemetry Events (Stub)

Accepts telemetry events and forwards them to the columnar store for query and alerting. Each event carries classification metadata and optional structured tags.

**Request:**
```json
[
  {
    "id": "01234567-89ab-cdef-0123-456789abcdef",
    "timestamp": 1710000000000000000,
    "kind": "metric",
    "service": "payment-api",
    "host": "prod-01",
    "tags": { "region": "us-east-1", "env": "production" }
  }
]
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique event ID (UUIDv7 recommended for time-sortability) |
| `timestamp` | number | Yes | Unix epoch **nanoseconds** |
| `kind` | `"metric"` \| `"trace"` \| `"log"` | Yes | Event classification |
| `service` | string | Yes | Originating service name |
| `host` | string | Yes | Host identifier |
| `tags` | Record\<string, string\> | Yes | Arbitrary key-value tags for filtering |

**Response (200):**
```json
{
  "accepted": 1,
  "timestamp": 1710000002000
}
```

---

## Query

### `POST /v1/query` — SQL Query

Executes a SQL query against the columnar store.

**Request:**
```json
{
  "sql": "SELECT service, count(*) FROM events WHERE isError = true GROUP BY service",
  "timeRange": {
    "startNs": 1710000000000000000,
    "endNs": 1710086400000000000
  },
  "limit": 100
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sql` | string | Yes | SQL query string |
| `timeRange` | object | — | Optional time range filter |
| `timeRange.startNs` | number | — | Start of range (nanoseconds) |
| `timeRange.endNs` | number | — | End of range (nanoseconds) |
| `limit` | number | — | Maximum rows to return |

**Response (200):**
```json
{
  "columns": ["service", "count"],
  "rows": [
    ["payment-api", 42],
    ["auth-service", 7]
  ],
  "durationNs": 150000,
  "totalRows": 2
}
```

| Field | Type | Description |
|-------|------|-------------|
| `columns` | string[] | Column names in the result set |
| `rows` | unknown[][] | Row data matching the column order |
| `durationNs` | number | Query execution time in nanoseconds |
| `totalRows` | number | Total matching rows (before `limit`) |

> **Note:** The query endpoint supports a subset of SQL. See the query route source for supported syntax.

---

### `GET /query/trace/:traceId` — Trace Lookup

Performs an O(1) hash lookup for a specific trace by ID.

**Request:** Pass the trace ID as a URL parameter.

```
GET /query/trace/abc-123
```

**Response (200):**
```json
{
  "traceId": "abc-123",
  "service": "payment-api",
  "durationMs": 42.5,
  "isError": false,
  "timestamp": 1710000000000
}
```

**Response (404):**
```json
{
  "error": "trace_not_found",
  "traceId": "abc-123"
}
```

> **Why O(1)?** The TypeScript store maintains a Map index on `traceId` for instant lookups regardless of store size. Trace lookup does not scan the columnar store.

---

---


# Contact and Support

---

## Get Help

| Channel | Contact | Use For |
|---------|---------|---------|
| Bug reports & feature requests | GitHub Issues | Bug reports, feature requests |
| Security | GitHub Security Advisory | Vulnerability reports |
| Questions | GitHub Discussions | General questions, help, discussions |

---

## Before You Contact Us

Many issues can be resolved with a quick check:

### Appliance won't start

```bash
# Check if the process is running
pgrep -a bun

# Check the health endpoint
curl -s http://localhost:3001/health | jq .
```

If the health check returns `Connection refused`, the server isn't running. Restart it:

```bash
cd /opt/aacyn/ts/apps/api
bun run src/index.ts
```

### Events not ingesting

```bash
# Send a test event
curl -X POST http://localhost:3001/ingest/batch \
  -H "Content-Type: application/json" \
  -d '{"events":[{"traceId":"test","service":"diag","durationMs":1,"isError":false,"timestamp":'$(date +%s000)'}]}'
```

| Response | Meaning |
|----------|---------|
| `202 {"accepted":1}` | Ingestion is working — check your application code |
| `422` | Request body doesn't match the event schema |
| `500` | Internal error — the store may be full; restart to clear |

### License issues

aacyn is licensed under Apache 2.0. See the LICENSE file in the repository root for details.

---

## Security Policy

We take security seriously. If you discover a vulnerability:

1. File a **GitHub Security Advisory** at https://github.com/aacyn/aacyn/security/advisories with a description of the issue
2. Include steps to reproduce if possible
3. We will acknowledge receipt through the GitHub Advisory workflow within 24 hours
4. We will not take legal action against good-faith security researchers

---

## Service Status

The aacyn appliance runs entirely on your hardware. There are **no mandatory external dependencies**.

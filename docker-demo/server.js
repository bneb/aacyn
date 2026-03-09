// aacyn Demo API — Uninstrumented Node.js HTTP server
// Receives HTTP requests, queries Postgres, simulates 30ms processing latency.
// Zero OTel. Zero SDKs.
const http = require('http');
const { Client } = require('pg');

const server = http.createServer(async (req, res) => {
  res.setHeader('Connection', 'close');
  try {
    const t0 = Date.now();
    const pg = new Client({ host: 'db', user: 'postgres', database: 'postgres' });
    await pg.connect();
    await pg.query('SELECT pg_sleep(0.03), now() as ts');
    await pg.end();
    const latency = Date.now() - t0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', latency_ms: latency, path: req.url }));
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.keepAliveTimeout = 0;
server.listen(3000, () => console.log('API listening on :3000 (Keep-Alive DISABLED)'));

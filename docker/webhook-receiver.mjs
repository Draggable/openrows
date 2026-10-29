// A webhook receiver for the dev and CI stacks only: the e2e spec points a webhook at
// http://webhook-receiver:8190/<path>, the worker POSTs there (dev.yml allows this one host and
// port in OUTBOUND_HTTP_*), and the spec reads what arrived from GET /requests. It answers 200 to
// every POST, or the status in `?status=` (to see failures in the delivery log). Never in prod.
import { createServer } from 'node:http';

// Not PORT: the app image sets that for the api.
const PORT = Number(process.env.WEBHOOK_RECEIVER_PORT || 8190);
const MAX = 200;
const received = [];

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://receiver');
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200).end('ok');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/requests') {
    const path = url.searchParams.get('path');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(received.filter((r) => !path || r.path === path)));
    return;
  }
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size <= 1024 * 1024) chunks.push(c);
  });
  req.on('end', () => {
    received.push({
      at: new Date().toISOString(),
      method: req.method,
      path: url.pathname,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    if (received.length > MAX) received.shift();
    const status = Number(url.searchParams.get('status')) || 200;
    res.writeHead(status, { 'content-type': 'text/plain' }).end(status < 300 ? 'ok' : 'failing');
  });
}).listen(PORT, '127.0.0.1');

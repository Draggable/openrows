// A fake of Airtable's Web API for the dev and CI stacks only: the e2e spec imports the
// recorded fixture base (packages/server/src/airtable/__fixtures__, mounted read-only at
// /fixtures) through the UI. dev.yml points the api and worker at it (AIRTABLE_API_URL) and
// allows its host for attachments (AIRTABLE_ATTACHMENT_HOSTS) and in OUTBOUND_HTTP_*. Files the
// fixture names on Airtable's CDN are served from /files/<host>/<path> here. Never in prod.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

// Not PORT: the app image sets that for the api.
const PORT = Number(process.env.AIRTABLE_FAKE_PORT || 8191);
const ORIGIN = process.env.AIRTABLE_FAKE_ORIGIN || `http://airtable-fake:${PORT}`;
const DIR = process.env.AIRTABLE_FAKE_FIXTURES || '/fixtures';
const TOKEN = `patFixture0000001.${'a1b2c3d4'.repeat(8)}`;
const BASE_ID = 'appFixtureBase001';

const read = (name) => JSON.parse(readFileSync(`${DIR}/${name}`, 'utf8'));
const bases = read('bases.json');
const schema = read('schema.json');
// Airtable's file URLs → this server's.
const records = JSON.parse(
  JSON.stringify(read('records.json')).replace(
    /https:\/\/(v5\.airtableusercontent\.com|dl\.airtable\.com)\//g,
    `${ORIGIN}/files/$1/`
  )
);

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
const FILES = {
  '/files/v5.airtableusercontent.com/v3/u/apollo-logo': [PNG, 'image/png'],
  '/files/v5.airtableusercontent.com/v3/u/apollo-brief': [
    Buffer.from('Apollo brief\n'),
    'text/plain',
  ],
  '/files/dl.airtable.com/.attachments/gone/fake.png': [Buffer.from('<svg></svg>'), 'image/png'],
};

const json = (res, status, body) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

createServer((req, res) => {
  const url = new URL(req.url ?? '/', ORIGIN);
  const path = url.pathname;
  if (path === '/health') return res.writeHead(200).end('ok');
  if (path.startsWith('/files/')) {
    const file = FILES[path];
    if (!file) return res.writeHead(404).end('not found');
    return res.writeHead(200, { 'content-type': file[1] }).end(file[0]);
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return json(res, 401, { error: { type: 'AUTHENTICATION_REQUIRED' } });
  }
  if (path === '/v0/meta/bases') return json(res, 200, bases);
  if (path === `/v0/meta/bases/${BASE_ID}/tables`) return json(res, 200, schema);
  const m = /^\/v0\/(app[A-Za-z0-9]{14})\/(tbl[A-Za-z0-9]{14})$/.exec(path);
  const list = m && m[1] === BASE_ID ? records[m[2]] : undefined;
  if (list) {
    const start = Number(url.searchParams.get('offset') ?? '0');
    const size = Math.min(100, Number(url.searchParams.get('pageSize') ?? '100'));
    const page = list.slice(start, start + size);
    const next = start + size < list.length ? { offset: String(start + size) } : {};
    return json(res, 200, { records: page, ...next });
  }
  return json(res, 403, { error: { type: 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND' } });
}).listen(PORT, '127.0.0.1');

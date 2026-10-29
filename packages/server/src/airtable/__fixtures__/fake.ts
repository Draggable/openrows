import { readFileSync } from 'node:fs';
import type { SafeFetch, SafeFetchInit, SafeResponse } from '../../lib/safe-fetch/index.js';

/**
 * A fake of Airtable's Web API for tests (#113): no live calls in CI. It answers from recorded
 * responses in this directory, in Airtable's shapes (`bases.json`: GET /v0/meta/bases;
 * `schema.json`: GET /v0/meta/bases/appFixtureBase001/tables; `records.json`: each table's
 * records, paged by 100 with `offset` like Airtable). It stands in for the SSRF-safe client, so
 * the importer's real client code runs against it. Besides api.airtable.com it answers Airtable's
 * file hosts (#114: `FIXTURE_FILES`, a 404 for any other path) and refuses every other host.
 *
 * `large` adds a generated base (#114, `LARGE_BASE_ID`): companies and their contacts, linked
 * both ways (a contact has one company), with a count and a lookup over the link.
 */

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')) as unknown;

export const FIXTURE_BASE_ID = 'appFixtureBase001';
/** Listed by the token but without a recorded schema: Airtable's 403. */
export const FIXTURE_OTHER_BASE_ID = 'appOtherBase00001';
export const FIXTURE_TOKEN = `patFixture0000001.${'a1b2c3d4'.repeat(8)}`;
export const LARGE_BASE_ID = 'appFixtureLarge01';

/** A 1×1 PNG. */
export const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

/** The files of the fixture's attachment cells, by URL. */
export const FIXTURE_FILES: Record<string, { body: Buffer; type: string }> = {
  'https://v5.airtableusercontent.com/v3/u/apollo-logo': { body: PNG_1PX, type: 'image/png' },
  'https://v5.airtableusercontent.com/v3/u/apollo-brief': {
    body: Buffer.from('Apollo brief\n'),
    type: 'text/plain',
  },
  // Not a PNG, whatever Airtable says: stored as a download.
  'https://dl.airtable.com/.attachments/gone/fake.png': {
    body: Buffer.from('<svg></svg>'),
    type: 'image/png',
  },
};

const FILE_HOSTS = new Set(['v5.airtableusercontent.com', 'dl.airtable.com']);

const pad = (n: number, width: number) => String(n).padStart(width, '0');
const INDUSTRIES = ['Software', 'Retail', 'Health', 'Energy'];

/** The generated base: `companies` companies, `contacts` contacts spread over them in turn. */
export function largeBase(companies: number, contacts: number) {
  const coId = (i: number) => `recCo${pad(i, 12)}`;
  const ctId = (i: number) => `recCt${pad(i, 12)}`;
  const schema = {
    tables: [
      {
        id: 'tblCompanies00001',
        name: 'Companies',
        primaryFieldId: 'fldCoName00000000',
        fields: [
          { id: 'fldCoName00000000', name: 'Name', type: 'singleLineText' },
          {
            id: 'fldCoIndustry0000',
            name: 'Industry',
            type: 'singleSelect',
            options: { choices: INDUSTRIES.map((name, i) => ({ id: `sel${i}`, name })) },
          },
          {
            id: 'fldCoContacts0000',
            name: 'Contacts',
            type: 'multipleRecordLinks',
            options: {
              linkedTableId: 'tblContacts000001',
              inverseLinkFieldId: 'fldCtCompany00000',
              prefersSingleRecordLink: false,
            },
          },
          {
            id: 'fldCoCount0000000',
            name: 'Contact count',
            type: 'count',
            options: { isValid: true, recordLinkFieldId: 'fldCoContacts0000' },
          },
        ],
        views: [{ id: 'viwCompanies00001', name: 'Grid view', type: 'grid' }],
      },
      {
        id: 'tblContacts000001',
        name: 'Contacts',
        primaryFieldId: 'fldCtName00000000',
        fields: [
          { id: 'fldCtName00000000', name: 'Name', type: 'singleLineText' },
          { id: 'fldCtEmail0000000', name: 'Email', type: 'email' },
          { id: 'fldCtScore0000000', name: 'Score', type: 'number', options: { precision: 0 } },
          {
            id: 'fldCtCompany00000',
            name: 'Company',
            type: 'multipleRecordLinks',
            options: {
              linkedTableId: 'tblCompanies00001',
              inverseLinkFieldId: 'fldCoContacts0000',
              prefersSingleRecordLink: true,
            },
          },
          {
            id: 'fldCtIndustry0000',
            name: 'Industry',
            type: 'multipleLookupValues',
            options: {
              isValid: true,
              recordLinkFieldId: 'fldCtCompany00000',
              fieldIdInLinkedTable: 'fldCoIndustry0000',
              result: { type: 'singleSelect' },
            },
          },
        ],
        views: [{ id: 'viwContacts000001', name: 'Grid view', type: 'grid' }],
      },
    ],
  };
  const companyOf = (contact: number) => contact % companies;
  const records: Record<string, (i: number) => unknown> = {
    tblCompanies00001: (i) => ({
      id: coId(i),
      fields: {
        fldCoName00000000: `Company ${i}`,
        fldCoIndustry0000: INDUSTRIES[i % INDUSTRIES.length],
        fldCoContacts0000: Array.from({ length: Math.ceil((contacts - i) / companies) }, (_, k) =>
          ctId(i + k * companies)
        ).filter((_, k) => i + k * companies < contacts),
        fldCoCount0000000: Math.ceil((contacts - i) / companies),
      },
    }),
    tblContacts000001: (i) => ({
      id: ctId(i),
      fields: {
        fldCtName00000000: `Contact ${i}`,
        fldCtEmail0000000: `contact${i}@example.test`,
        fldCtScore0000000: i % 100,
        fldCtCompany00000: [coId(companyOf(i))],
        fldCtIndustry0000: [INDUSTRIES[companyOf(i) % INDUSTRIES.length]],
      },
    }),
  };
  const sizes: Record<string, number> = {
    tblCompanies00001: companies,
    tblContacts000001: contacts,
  };
  return { schema, records, sizes, coId, ctId, companyOf };
}

export interface FakeRequest {
  url: string;
  method: string;
  authorization: string | undefined;
  at: number;
}

export interface FakeAirtable {
  http: SafeFetch;
  requests: FakeRequest[];
  /** Answer the next `n` requests with 429 (Airtable's rate limit). */
  rateLimitNext(n: number): void;
  /** Fail every request from now on (a 503, or a thrown error). */
  failWith(status: number | null): void;
}

function response(status: number, body: unknown, url: string): SafeResponse {
  const text = JSON.stringify(body);
  return {
    status,
    statusText: String(status),
    headers: new Headers({ 'content-type': 'application/json' }),
    url,
    redirected: false,
    body: Buffer.from(text),
    text: () => text,
  };
}

export function fakeAirtable(
  opts: { token?: string; pageSize?: number; large?: { companies: number; contacts: number } } = {}
): FakeAirtable {
  const token = opts.token ?? FIXTURE_TOKEN;
  const pageSize = opts.pageSize ?? 100;
  const listed = read('bases.json') as { bases: unknown[] };
  const large = opts.large ? largeBase(opts.large.companies, opts.large.contacts) : null;
  const bases = large
    ? {
        bases: [
          ...listed.bases,
          { id: LARGE_BASE_ID, name: 'Customers (20k)', permissionLevel: 'create' },
        ],
      }
    : listed;
  const schema = read('schema.json');
  const records = read('records.json') as Record<string, unknown[]>;
  const requests: FakeRequest[] = [];
  let limited = 0;
  let failing: number | null | undefined;

  const http: SafeFetch = async (input, init: SafeFetchInit = {}) => {
    const url = new URL(String(input));
    const authorization = init.headers?.['authorization'];
    requests.push({ url: url.href, method: init.method ?? 'GET', authorization, at: Date.now() });
    if (url.protocol === 'https:' && FILE_HOSTS.has(url.host)) {
      const file = FIXTURE_FILES[url.href];
      if (!file) return response(404, { error: 'NOT_FOUND' }, url.href);
      return {
        status: 200,
        statusText: '200',
        headers: new Headers({ 'content-type': file.type }),
        url: url.href,
        redirected: false,
        body: file.body,
        text: () => file.body.toString('utf8'),
      };
    }
    if (url.protocol !== 'https:' || url.host !== 'api.airtable.com') {
      throw new Error(`fake airtable: refused ${url.host}`);
    }
    if (failing === null) throw new Error('fake airtable: connection reset');
    if (failing !== undefined) return response(failing, { error: 'down' }, url.href);
    if (limited > 0) {
      limited--;
      return response(429, { errors: [{ error: 'RATE_LIMIT_REACHED' }] }, url.href);
    }
    if (authorization !== `Bearer ${token}`) {
      return response(401, { error: { type: 'AUTHENTICATION_REQUIRED' } }, url.href);
    }
    const path = url.pathname;
    if (path === '/v0/meta/bases') return response(200, bases, url.href);
    if (path === `/v0/meta/bases/${FIXTURE_BASE_ID}/tables`) return response(200, schema, url.href);
    if (large && path === `/v0/meta/bases/${LARGE_BASE_ID}/tables`) {
      return response(200, large.schema, url.href);
    }
    const m = /^\/v0\/(app[A-Za-z0-9]{14})\/(tbl[A-Za-z0-9]{14})$/.exec(path);
    const generate = m && large && m[1] === LARGE_BASE_ID ? large.records[m[2] ?? ''] : undefined;
    if (generate && large && m) {
      const total = large.sizes[m[2] ?? ''] ?? 0;
      const start = Number(url.searchParams.get('offset') ?? '0');
      const size = Math.min(pageSize, Number(url.searchParams.get('pageSize') ?? '100'));
      const page = Array.from({ length: Math.max(0, Math.min(size, total - start)) }, (_, k) =>
        generate(start + k)
      );
      const next = start + size < total ? { offset: String(start + size) } : {};
      return response(200, { records: page, ...next }, url.href);
    }
    const list = m && m[1] === FIXTURE_BASE_ID ? records[m[2] ?? ''] : undefined;
    if (list) {
      if (url.searchParams.get('returnFieldsByFieldId') !== 'true') {
        return response(422, { error: { type: 'INVALID_REQUEST_UNKNOWN' } }, url.href);
      }
      const start = Number(url.searchParams.get('offset') ?? '0');
      const size = Math.min(pageSize, Number(url.searchParams.get('pageSize') ?? '100'));
      const page = list.slice(start, start + size);
      const next = start + size < list.length ? { offset: String(start + size) } : {};
      return response(200, { records: page, ...next }, url.href);
    }
    return response(403, { error: { type: 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND' } }, url.href);
  };
  return {
    http,
    requests,
    rateLimitNext(n) {
      limited = n;
    },
    failWith(status) {
      failing = status;
    },
  };
}

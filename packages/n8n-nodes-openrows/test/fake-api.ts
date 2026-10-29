import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A fake of OpenRows' REST API v1 for one base, in memory, on a random local port: enough of
 * meta, records (list pages, create, update, upsert, delete) and webhooks for the nodes' tests.
 * It checks the bearer token, records every request, and can be told to answer the next
 * requests with a given status (429s, validation errors). `filterByFormula` isn't evaluated:
 * tests read the formula the node sent.
 */

export const TOKEN = 'or_pat_test_0123456789abcdef';

export interface FakeField {
  id: string;
  name: string;
  type: string;
  openrowsType: string;
  options?: unknown;
}

export interface FakeTable {
  id: string;
  name: string;
  primaryFieldId: string;
  fields: FakeField[];
  views: { id: string; name: string; type: string }[];
}

export interface FakeRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

export interface FakeWebhook {
  id: string;
  url: string;
  description: string;
  events: string[];
  tableIds: string[] | null;
  enabled: boolean;
  secret: string;
}

export interface Recorded {
  method: string;
  path: string;
  query: string;
  body: unknown;
  authorization: string | undefined;
}

interface Override {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const field = (name: string, openrowsType: string, options?: unknown): FakeField => ({
  id: randomUUID(),
  name,
  type: openrowsType,
  openrowsType,
  ...(options === undefined ? {} : { options }),
});

export function fakeApi() {
  const baseId = randomUUID();
  const otherBaseId = randomUUID();
  const name = field('Name', 'singleLineText');
  const tasks: FakeTable = {
    id: randomUUID(),
    name: 'Tasks',
    primaryFieldId: name.id,
    fields: [
      name,
      field('Notes', 'longText'),
      field('Email', 'email'),
      field('Estimate', 'number'),
      field('Done', 'checkbox'),
      field('Due', 'date'),
      field('Status', 'singleSelect', {
        choices: [
          { id: randomUUID(), name: 'Todo', color: 'green' },
          { id: randomUUID(), name: 'Shipped', color: 'blue' },
        ],
      }),
      field('Tags', 'multipleSelect', { choices: [] }),
      field('Score', 'formula'),
      field('Created', 'createdTime'),
    ],
    views: [{ id: randomUUID(), name: 'Grid', type: 'grid' }],
  };
  const empty: FakeTable = {
    id: randomUUID(),
    name: 'Numbers only',
    primaryFieldId: '',
    fields: [field('Count', 'number')],
    views: [],
  };
  const tables = [tasks, empty];
  const records = new Map<string, FakeRecord[]>(tables.map((t) => [t.id, []]));
  const webhooks: FakeWebhook[] = [];
  const requests: Recorded[] = [];
  const overrides: Override[] = [];

  const table = (base: string, idOrName: string) =>
    base === baseId ? tables.find((t) => t.id === idOrName || t.name === idOrName) : undefined;

  const newRecord = (fields: Record<string, unknown>): FakeRecord => ({
    id: randomUUID(),
    createdTime: new Date().toISOString(),
    fields: { ...fields },
  });

  type Answer = { status: number; body?: unknown; headers?: Record<string, string> };
  const notFound = (message = 'Not found'): Answer => ({
    status: 404,
    body: { error: { type: 'NOT_FOUND', message, code: 'NOT_FOUND', requestId: 'req-404' } },
  });
  const invalid = (message: string): Answer => ({
    status: 422,
    body: {
      error: { type: 'INVALID_REQUEST_UNKNOWN', message, code: 'VALIDATION', requestId: 'req-422' },
    },
  });

  function route(method: string, path: string, query: URLSearchParams, body: unknown): Answer {
    const parts = path
      .replace(/^\/api\/v1\//, '')
      .split('/')
      .map(decodeURIComponent);
    const b = (body ?? {}) as Record<string, unknown>;
    if (parts[0] === 'meta' && parts[1] === 'bases') {
      if (parts.length === 2 && method === 'GET') {
        return {
          status: 200,
          body: {
            bases: [
              { id: baseId, name: 'Roadmap', permissionLevel: 'owner' },
              { id: otherBaseId, name: 'Archive', permissionLevel: 'read' },
            ],
          },
        };
      }
      if (parts.length === 4 && parts[3] === 'tables' && method === 'GET') {
        if (parts[2] !== baseId) return notFound();
        return { status: 200, body: { tables } };
      }
      return notFound();
    }
    if (parts[0] === 'bases' && parts[2] === 'webhooks') {
      if (parts[1] !== baseId) return notFound();
      const hookId = parts[3];
      if (!hookId && method === 'GET') {
        return { status: 200, body: { webhooks: webhooks.map(({ secret: _s, ...h }) => h) } };
      }
      if (!hookId && method === 'POST') {
        if (typeof b['url'] !== 'string' || !Array.isArray(b['events'])) {
          return invalid('url and events are required');
        }
        const hook: FakeWebhook = {
          id: randomUUID(),
          url: b['url'],
          description: String(b['description'] ?? ''),
          events: b['events'] as string[],
          tableIds: (b['tableIds'] as string[] | null) ?? null,
          enabled: true,
          secret: `whsec_${randomUUID()}`,
        };
        webhooks.push(hook);
        return { status: 201, body: hook };
      }
      if (hookId && method === 'DELETE') {
        const at = webhooks.findIndex((h) => h.id === hookId);
        if (at < 0) return notFound();
        webhooks.splice(at, 1);
        return { status: 204 };
      }
      return notFound();
    }
    const [base = '', tableName = '', third] = parts;
    const t = table(base, tableName);
    if (!t) return notFound('Could not find table');
    const rows = records.get(t.id) ?? [];
    if (third === 'listRecords' && method === 'POST') {
      const start = b['offset'] === undefined ? 0 : Number(b['offset']);
      const size = Number(b['pageSize'] ?? 100);
      const page = rows.slice(start, start + size);
      const next = start + size < rows.length ? String(start + size) : undefined;
      return { status: 200, body: { records: page, ...(next ? { offset: next } : {}) } };
    }
    if (third) {
      const record = rows.find((r) => r.id === third);
      if (!record) return notFound('Could not find record');
      if (method === 'GET') return { status: 200, body: record };
      return notFound();
    }
    const input = (b['records'] ?? []) as { id?: string; fields: Record<string, unknown> }[];
    if (method === 'POST') {
      if (input.length < 1 || input.length > 10) return invalid('1 to 10 records');
      const created = input.map((r) => newRecord(r.fields));
      rows.push(...created);
      return { status: 200, body: { records: created } };
    }
    if (method === 'PATCH') {
      if (input.length < 1 || input.length > 10) return invalid('1 to 10 records');
      const mergeOn = (b['performUpsert'] as { fieldsToMergeOn: string[] } | undefined)
        ?.fieldsToMergeOn;
      const createdRecords: string[] = [];
      const updatedRecords: string[] = [];
      const out: FakeRecord[] = [];
      for (const r of input) {
        let found = r.id ? rows.find((x) => x.id === r.id) : undefined;
        if (r.id && !found) return notFound('Could not find record');
        if (!found && mergeOn) {
          found = rows.find((x) => mergeOn.every((f) => x.fields[f] === r.fields[f]));
        }
        if (found) {
          Object.assign(found.fields, r.fields);
          updatedRecords.push(found.id);
          out.push(found);
        } else {
          const created = newRecord(r.fields);
          rows.push(created);
          createdRecords.push(created.id);
          out.push(created);
        }
      }
      return {
        status: 200,
        body: { records: out, ...(mergeOn ? { createdRecords, updatedRecords } : {}) },
      };
    }
    if (method === 'DELETE') {
      const ids = query.getAll('records[]');
      if (ids.length < 1 || ids.length > 10) return invalid('1 to 10 records');
      for (const id of ids) {
        const at = rows.findIndex((r) => r.id === id);
        if (at < 0) return notFound('Could not find record');
        rows.splice(at, 1);
      }
      return { status: 200, body: { records: ids.map((id) => ({ id, deleted: true })) } };
    }
    return notFound();
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? (JSON.parse(text) as unknown) : undefined;
      requests.push({
        method: req.method ?? '',
        path: url.pathname,
        query: url.search.replace(/^\?/, ''),
        body,
        authorization: req.headers.authorization,
      });
      let answer: Answer;
      const override = overrides.shift();
      if (override) answer = override;
      else if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        answer = {
          status: 401,
          body: { error: { type: 'AUTHENTICATION_REQUIRED', message: 'Sign in first.' } },
        };
      } else answer = route(req.method ?? 'GET', url.pathname, url.searchParams, body);
      res.writeHead(answer.status, {
        ...(answer.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...answer.headers,
      });
      res.end(answer.body === undefined ? undefined : JSON.stringify(answer.body));
    });
  });

  return {
    baseId,
    otherBaseId,
    tasks,
    empty,
    records,
    webhooks,
    requests,
    /** Answers the next request with this, whatever it is. */
    answerNext(status: number, body: unknown, headers?: Record<string, string>) {
      overrides.push({ status, body, headers });
    },
    seed(t: FakeTable, ...fields: Record<string, unknown>[]) {
      const created = fields.map(newRecord);
      records.get(t.id)?.push(...created);
      return created;
    },
    async start(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type FakeApi = ReturnType<typeof fakeApi>;

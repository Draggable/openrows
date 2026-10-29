import type { AirtableImport, RecordData, TableMeta } from '@openrows/shared';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_TOKEN,
  fakeAirtable,
  LARGE_BASE_ID,
} from '../../src/airtable/__fixtures__/fake.js';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { createSession, createWorkspace } from '../helpers/factories.js';

/**
 * The acceptance: a 20,000-record Airtable base with links imports correctly. The
 * generated fixture has 1,000 companies and 19,000 contacts, each contact linked to one company
 * (Airtable's two sides of the link), a count of contacts per company and a lookup of the
 * company's industry per contact.
 */
const COMPANIES = 1_000;
const CONTACTS = 19_000;

describe('Airtable import of a 20k-record base', () => {
  const t = useTestDb();
  let app: ReturnType<typeof testApp>;
  let workspaceId: string;
  let cookie: string;

  const request = (method: string, path: string, body?: unknown) =>
    app.app.request(path, {
      method,
      headers: {
        origin: app.config.appUrl,
        cookie: `${SESSION_COOKIE}=${cookie}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  async function ok<T>(res: Response, status = 200): Promise<T> {
    const text = await res.text();
    if (res.status !== status) throw new Error(`${res.status}: ${text}`);
    return JSON.parse(text) as T;
  }

  beforeAll(async () => {
    const fake = fakeAirtable({ large: { companies: COMPANIES, contacts: CONTACTS } });
    app = testApp({ db: t.appDb, airtable: { http: fake.http, sleep: async () => {} } });
    const { workspace, owner } = await createWorkspace(t.db);
    workspaceId = workspace.id;
    cookie = await createSession(t.db, owner);
  });

  it('imports every record and link, with the count and lookup over them', async () => {
    const { imports } = await ok<{ imports: AirtableImport[] }>(
      await request('POST', `/api/workspaces/${workspaceId}/airtable/imports`, {
        token: FIXTURE_TOKEN,
        baseIds: [LARGE_BASE_ID],
      }),
      201
    );
    const job = imports[0] as AirtableImport;
    const started = Date.now();
    await app.runJob(job.id);
    const seconds = (Date.now() - started) / 1000;
    const done = await ok<AirtableImport>(
      await request('GET', `/api/workspaces/${workspaceId}/airtable/imports/${job.id}`)
    );
    expect(done).toMatchObject({
      status: 'done',
      error: null,
      records: COMPANIES + CONTACTS,
      // Written from the contacts' side: one link per cell.
      linkedRecords: CONTACTS,
      percent: 100,
    });
    expect(done.report.skippedLinks).toBe(0);
    expect(done.report.unsupportedFields).toEqual([]);
    expect(done.report.converted).toEqual([]);
    // A reasonable time on CI (locally about a minute).
    expect(seconds).toBeLessThan(600);

    const list = await ok<{ tables: { id: string; name: string }[] }>(
      await request('GET', `/api/bases/${job.baseId}/tables`)
    );
    const meta = async (name: string) =>
      ok<TableMeta>(
        await request('GET', `/api/tables/${list.tables.find((x) => x.name === name)?.id}`)
      );
    const companies = await meta('Companies');
    const contacts = await meta('Contacts');
    const fieldId = (table: TableMeta, name: string) =>
      table.fields.find((f) => f.name === name)?.id ?? '';
    expect(contacts.fields.find((f) => f.name === 'Industry')?.type).toBe('lookup');
    expect(companies.fields.find((f) => f.name === 'Contact count')?.type).toBe('count');

    // Every record is there, and the junction holds every link once.
    const count = async (table: TableMeta) => {
      const { rows: where } = await t.db.execute<{ s: string; t: string }>(
        sql`SELECT db_schema AS s, db_table AS t FROM tables WHERE id = ${table.id}`
      );
      const { rows } = await t.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM ${sql.identifier(where[0]?.s ?? '')}.${sql.identifier(where[0]?.t ?? '')}`
      );
      return rows[0]?.n;
    };
    expect(await count(companies)).toBe(COMPANIES);
    expect(await count(contacts)).toBe(CONTACTS);

    // Company 7 has the contacts 7, 1007, 2007, …: 19 of them, each linked back to it.
    const page = await ok<{ records: RecordData[] }>(
      await request('POST', `/api/tables/${companies.id}/records/query`, {
        query: {
          filter: {
            conjunction: 'and',
            conditions: [
              { fieldId: fieldId(companies, 'Name'), operator: 'is', value: 'Company 7' },
            ],
          },
        },
      })
    );
    const seven = page.records[0];
    expect(seven?.fields[fieldId(companies, 'Contact count')]).toBe(CONTACTS / COMPANIES);
    const linked = (seven?.fields[fieldId(companies, 'Contacts')] ?? []) as { name: string }[];
    expect(linked.map((l) => l.name).sort()).toEqual(
      Array.from({ length: 19 }, (_, k) => `Contact ${7 + k * COMPANIES}`).sort()
    );
    // The lookup reads the company's industry (Company 7: 7 % 4 → Energy).
    const contact = await ok<{ records: RecordData[] }>(
      await request('POST', `/api/tables/${contacts.id}/records/query`, {
        query: {
          filter: {
            conjunction: 'and',
            conditions: [
              { fieldId: fieldId(contacts, 'Name'), operator: 'is', value: 'Contact 18007' },
            ],
          },
        },
      })
    );
    const c = contact.records[0];
    expect(c?.fields[fieldId(contacts, 'Company')]).toEqual([
      expect.objectContaining({ id: seven?.id, name: 'Company 7' }),
    ]);
    expect(c?.fields[fieldId(contacts, 'Industry')]).toEqual(['Energy']);
  }, 900_000);
});

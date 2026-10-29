import type { AttachmentValue, FieldMeta, RecordData, TableMeta } from '@openrows/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clamdScanner } from '../../src/attachments/scan.js';
import { runScanJob, SCAN_SWEEP_AFTER_MS, sweepScans } from '../../src/attachments/scan-job.js';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import type { users } from '../../src/db/index.js';
import type { EmailMessage } from '../../src/email/transport.js';
import { testApp } from '../helpers/app.js';
import { EICAR, type FakeClamd, startFakeClamd } from '../helpers/clamd.js';
import { useTestDb } from '../helpers/db.js';
import { createSession, createUser, createWorkspace } from '../helpers/factories.js';
import { MemoryObjectStore } from '../helpers/object-store.js';

/**
 * Malware scanning of uploads, with CLAMAV_URL set: a confirmed upload is `scanning` and
 * has its `attachments.scan` job; a cell may name it, but it isn't served until the worker's scan
 * (here against a fake clamd that detects the EICAR test file) marks it ready. An infected file
 * is quarantined: never served, never usable again, and its uploader is emailed. A scanner that
 * is down leaves the file waiting, and the sweep sends its scan again.
 */
describe('attachment malware scans', () => {
  const t = useTestDb();
  const store = new MemoryObjectStore();
  let clamd: FakeClamd;
  let app: ReturnType<typeof testApp>;
  let owner: typeof users.$inferSelect;
  let cookie: string;
  let table: TableMeta;
  let field: FieldMeta;
  let record: RecordData;
  const sent: EmailMessage[] = [];

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
    if (res.status !== status) throw new Error(`${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  const scanDeps = () => ({
    db: t.appDb,
    store,
    scanner: clamdScanner({ host: clamd.host, port: clamd.port, timeoutMs: 2000 }),
    logger: app.logger,
    email: { send: async (m: EmailMessage) => void sent.push(m) },
    appUrl: app.config.appUrl,
  });

  beforeAll(async () => {
    clamd = await startFakeClamd();
    app = testApp({
      db: t.appDb,
      objectStore: store,
      config: { clamav: { host: clamd.host, port: clamd.port } },
    });
    owner = await createUser(t.db, { email: 'scan-owner@example.com', emailVerified: true });
    const { workspace: ws } = await createWorkspace(t.db, { owner, name: 'Scans' });
    cookie = await createSession(t.db, owner);
    const base = await ok<{ id: string }>(
      await request('POST', `/api/workspaces/${ws.id}/bases`, { name: 'Base' }),
      201
    );
    table = await ok<TableMeta>(
      await request('POST', `/api/bases/${base.id}/tables`, { name: 'Tasks' }),
      201
    );
    field = await ok<FieldMeta>(
      await request('POST', `/api/tables/${table.id}/fields`, {
        name: 'Files',
        type: 'attachment',
      }),
      201
    );
    const created = await ok<{ records: RecordData[] }>(
      await request('POST', `/api/tables/${table.id}/records`, { records: [{ fields: {} }] }),
      201
    );
    const first = created.records[0];
    if (!first) throw new Error('no record');
    record = first;
  });
  afterAll(() => clamd.close());

  /** Announces, "uploads" (straight into the store) and confirms a file. */
  async function upload(filename: string, content: string) {
    const bytes = new TextEncoder().encode(content);
    const { attachment } = await ok<{ attachment: AttachmentValue }>(
      await request('POST', `/api/tables/${table.id}/attachments`, {
        fieldId: field.id,
        filename,
        type: 'text/plain',
        size: bytes.byteLength,
      }),
      201
    );
    const { rows } = await t.db.execute<{ storage_key: string }>(
      sql`SELECT storage_key FROM attachments WHERE id = ${attachment.id}`
    );
    await store.put(rows[0]?.storage_key ?? '', bytes);
    const confirmed = await ok<AttachmentValue>(
      await request('POST', `/api/tables/${table.id}/attachments/${attachment.id}/confirm`)
    );
    return confirmed;
  }

  async function statusOf(id: string) {
    const { rows } = await t.db.execute<{
      status: string;
      scan_result: string | null;
      scanned_at: Date | null;
    }>(sql`SELECT status, scan_result, scanned_at FROM attachments WHERE id = ${id}`);
    return rows[0];
  }

  async function scanJobs(id: string) {
    const { rows } = await t.db.execute<{ data: { workspaceId: string; attachmentId: string } }>(
      sql`SELECT data FROM pgboss.job WHERE name = 'attachments.scan' AND singleton_key = ${id}`
    );
    return rows.map((r) => r.data);
  }

  const download = (id: string) => request('GET', `/api/tables/${table.id}/attachments/${id}`);
  const putCell = (value: AttachmentValue[]) =>
    request('PATCH', `/api/tables/${table.id}/records/${record.id}`, {
      fields: { [field.id]: value },
    });

  it('a clean file waits for its scan, can go into a cell meanwhile, then is served', async () => {
    const file = await upload('notes.txt', 'just some notes');
    expect((await statusOf(file.id))?.status).toBe('scanning');
    const jobs = await scanJobs(file.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.attachmentId).toBe(file.id);

    // Not served before the scan.
    const early = await download(file.id);
    expect(early.status).toBe(409);
    expect(((await early.json()) as { code: string }).code).toBe('ATTACHMENT_SCANNING');
    // A cell may take it already (the upload flow writes the cell right after the confirm).
    expect((await putCell([file])).status).toBe(200);
    // Confirming again changes nothing and sends no second job.
    await ok(await request('POST', `/api/tables/${table.id}/attachments/${file.id}/confirm`));
    expect(await scanJobs(file.id)).toHaveLength(1);

    const result = await runScanJob(scanDeps(), jobs[0]);
    expect(result).toEqual({ outcome: 'clean' });
    const row = await statusOf(file.id);
    expect(row?.status).toBe('ready');
    expect(row?.scanned_at).not.toBeNull();
    expect((await download(file.id)).status).toBe(302);
    // A second run (a retry, the sweep) is a no-op.
    expect(await runScanJob(scanDeps(), jobs[0])).toEqual({ outcome: 'skipped' });
  });

  it('the EICAR test file is quarantined: never served or usable, and the uploader is told', async () => {
    sent.length = 0;
    const file = await upload('invoice.txt', EICAR);
    const [job] = await scanJobs(file.id);
    expect(await runScanJob(scanDeps(), job)).toEqual({ outcome: 'infected' });
    const row = await statusOf(file.id);
    expect(row).toMatchObject({ status: 'infected', scan_result: 'Eicar-Test-Signature' });

    const res = await download(file.id);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('ATTACHMENT_QUARANTINED');
    expect(
      (await request('GET', `/api/tables/${table.id}/attachments/${file.id}/thumbnail`)).status
    ).toBe(403);
    // No cell takes it.
    expect((await putCell([file])).status).toBe(422);
    // Confirming it again doesn't bring it back.
    expect(
      (await request('POST', `/api/tables/${table.id}/attachments/${file.id}/confirm`)).status
    ).toBe(403);
    // The object stays in the bucket for review (quarantine), it is just never served.
    expect(store.objects.size).toBeGreaterThan(0);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('scan-owner@example.com');
    expect(sent[0]?.subject).toBe('A file in Base was quarantined');
    expect(sent[0]?.text).toContain('invoice.txt');
    expect(sent[0]?.text).toContain('Eicar-Test-Signature');
    expect(app.logs.some((l) => l['msg'] === 'attachment quarantined: malware found')).toBe(true);
  });

  it('scanner down: the file waits (never passes), and the sweep sends its scan again', async () => {
    const file = await upload('later.txt', 'scanned later');
    const [job] = await scanJobs(file.id);
    for (const mode of ['error', 'hang', 'limit'] as const) {
      clamd.mode = mode;
      await expect(runScanJob(scanDeps(), job)).rejects.toThrow();
      expect((await statusOf(file.id))?.status).toBe('scanning');
    }
    clamd.mode = 'ok';
    const down = { ...scanDeps(), scanner: clamdScanner({ host: '127.0.0.1', port: 1 }) };
    await expect(runScanJob(down, job)).rejects.toThrow(/unreachable/);
    expect((await download(file.id)).status).toBe(409);

    // The job ran out of retries: the sweep finds the file (as openrows_app, across tenants).
    await t.db.execute(sql`DELETE FROM pgboss.job WHERE name = 'attachments.scan'`);
    const sends: unknown[] = [];
    const boss = {
      send: async (_q: string, data: object) => {
        sends.push(data);
        return 'id';
      },
    };
    expect(await sweepScans(t.appDb, boss as never, new Date())).toEqual({ sent: 0 });
    const later = new Date(Date.now() + SCAN_SWEEP_AFTER_MS + 1000);
    const swept = await sweepScans(t.appDb, boss as never, later);
    expect(swept.sent).toBeGreaterThanOrEqual(1);
    expect(sends).toContainEqual({ workspaceId: job?.workspaceId, attachmentId: file.id });
    expect(
      await runScanJob(scanDeps(), { workspaceId: job?.workspaceId, attachmentId: file.id })
    ).toEqual({ outcome: 'clean' });
  });

  it('a scan job only sees its own workspace (RLS)', async () => {
    const file = await upload('mine.txt', 'mine');
    const { workspace: other } = await createWorkspace(t.db, { owner, name: 'Other' });
    expect(await runScanJob(scanDeps(), { workspaceId: other.id, attachmentId: file.id })).toEqual({
      outcome: 'skipped',
    });
    expect((await statusOf(file.id))?.status).toBe('scanning');
  });

  it('without CLAMAV_URL, uploads are ready when confirmed and no scan is sent', async () => {
    const plain = testApp({ db: t.appDb, objectStore: store, config: { clamav: undefined } });
    const bytes = new TextEncoder().encode('plain');
    const res = await plain.app.request(`/api/tables/${table.id}/attachments`, {
      method: 'POST',
      headers: {
        origin: plain.config.appUrl,
        cookie: `${SESSION_COOKIE}=${cookie}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ fieldId: field.id, filename: 'p.txt', size: bytes.byteLength }),
    });
    const { attachment } = await ok<{ attachment: AttachmentValue }>(res, 201);
    const { rows } = await t.db.execute<{ storage_key: string }>(
      sql`SELECT storage_key FROM attachments WHERE id = ${attachment.id}`
    );
    await store.put(rows[0]?.storage_key ?? '', bytes);
    const confirm = await plain.app.request(
      `/api/tables/${table.id}/attachments/${attachment.id}/confirm`,
      {
        method: 'POST',
        headers: { origin: plain.config.appUrl, cookie: `${SESSION_COOKIE}=${cookie}` },
      }
    );
    expect(confirm.status).toBe(200);
    expect((await statusOf(attachment.id))?.status).toBe('ready');
    expect(await scanJobs(attachment.id)).toHaveLength(0);
  });
});

import type {
  AttachmentUpload,
  AttachmentValue,
  CreatedShare,
  FieldMeta,
  FormLayout,
  PublicForm,
  RecordData,
  Revision,
  TableMeta,
  ViewMeta,
} from '@openrows/shared';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { attachments, formSubmissions, outbox, type users } from '../../src/db/index.js';
import type { CaptchaVerifier } from '../../src/forms/turnstile.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createWorkspace } from '../helpers/factories.js';
import { useTestS3 } from '../helpers/s3.js';

/**
 * Public forms: `/api/forms/:token` with no session. The stored layout is the allowlist
 * (legacy H4, mass assignment): extra fields, record ids, computed fields, `createdBy`, fields
 * hidden by their condition, people fields, link fields without a picker view (see
 * public-form-links.test.ts) and fields the edit permissions keep from
 * editors are all refused. Required answers, per-type validation, the CAPTCHA, rate limits,
 * idempotency, uploads that can only go into the new record, and nothing leaking back.
 */
describe('public forms', () => {
  const t = useTestDb();
  const s3 = useTestS3();
  let owner: typeof users.$inferSelect;
  let workspaceId: string;
  let app: ReturnType<typeof testApp>;
  let ownerCookie: string;

  const request = (
    a: ReturnType<typeof testApp>,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ) =>
    a.app.request(path, {
      method,
      headers: {
        origin: a.config.appUrl,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const asOwner = (method: string, path: string, body?: unknown) =>
    request(app, method, path, body, { cookie: `${SESSION_COOKIE}=${ownerCookie}` });

  async function ok<T>(res: Response, status = 200): Promise<T> {
    if (res.status !== status) throw new Error(`${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  const problemPaths = async (res: Response) => {
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors?: { path: string }[] };
    return (body.errors ?? []).map((e) => e.path).sort();
  };

  interface Fixture {
    table: TableMeta;
    form: ViewMeta;
    token: string;
    name: FieldMeta;
    kind: FieldMeta;
    details: FieldMeta;
    age: FieldMeta;
    files: FieldMeta;
    formula: FieldMeta;
    secret: FieldMeta;
    person: FieldMeta;
  }

  async function fixture(layout?: (f: Omit<Fixture, 'token' | 'form'>) => FormLayout) {
    const base = await ok<{ id: string }>(
      await asOwner('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Base' }),
      201
    );
    const table = await ok<TableMeta>(
      await asOwner('POST', `/api/bases/${base.id}/tables`, { name: 'Requests' }),
      201
    );
    const field = async (body: unknown) =>
      ok<FieldMeta>(await asOwner('POST', `/api/tables/${table.id}/fields`, body), 201);
    const name = table.fields.find((f) => f.isPrimary);
    if (!name) throw new Error('no primary field');
    const fields = {
      table,
      name,
      kind: await field({
        name: 'Kind',
        type: 'singleSelect',
        options: {
          choices: [
            { id: 'bug', name: 'Bug', color: 'red' },
            { id: 'idea', name: 'Idea', color: 'green' },
          ],
        },
      }),
      details: await field({ name: 'Details', type: 'longText' }),
      age: await field({ name: 'Age', type: 'number' }),
      files: await field({ name: 'Files', type: 'attachment' }),
      formula: await field({ name: 'Calc', type: 'formula', options: { formula: '1 + 1' } }),
      secret: await field({ name: 'Internal note', type: 'singleLineText' }),
      person: await field({ name: 'Owner', type: 'user' }),
    };
    const form = await ok<ViewMeta>(
      await asOwner('POST', `/api/tables/${table.id}/views`, { name: 'Intake', type: 'form' }),
      201
    );
    const wanted: FormLayout = layout?.(fields) ?? {
      title: 'Report a problem',
      fields: [
        { fieldId: name.id, required: true, allowPrefill: true },
        { fieldId: fields.kind.id, allowPrefill: true },
        {
          fieldId: fields.details.id,
          required: true,
          condition: {
            conjunction: 'and',
            conditions: [{ fieldId: fields.kind.id, operator: 'is', value: 'bug' }],
          },
        },
        { fieldId: fields.age.id },
        { fieldId: fields.files.id },
        { fieldId: fields.person.id },
      ],
    };
    await ok(await asOwner('PATCH', `/api/views/${form.id}`, { form: wanted }));
    const { token } = await ok<CreatedShare>(
      await asOwner('POST', `/api/views/${form.id}/shares`, {}),
      201
    );
    return { ...fields, form, token };
  }

  const submit = (token: string, fields: Record<string, unknown>, extra: object = {}, a = app) =>
    request(a, 'POST', `/api/forms/${token}/submissions`, {
      submissionId: uuidv7(),
      fields,
      ...extra,
    });

  const records = async (tableId: string) =>
    (await ok<{ records: RecordData[] }>(await asOwner('GET', `/api/tables/${tableId}/records`)))
      .records;

  beforeAll(async () => {
    const created = await createWorkspace(t.db);
    owner = created.owner;
    workspaceId = created.workspace.id;
    app = testApp({ db: t.appDb, config: { s3: s3() } });
    ownerCookie = await createSession(t.db, owner);
  });

  it('answers the form without a session: only answerable fields, no ids of anything else', async () => {
    const f = await fixture();
    const res = await request(app, 'GET', `/api/forms/${f.token}`);
    const form = await ok<PublicForm>(res);
    expect(form.title).toBe('Report a problem');
    expect(form.captchaSiteKey).toBeNull();
    expect(form.fields.map((x) => x.id)).toEqual([
      f.name.id,
      f.kind.id,
      f.details.id,
      f.age.id,
      f.files.id,
    ]);
    // People fields aren't publicly answerable (they'd list the base's collaborators).
    const text = JSON.stringify(form);
    for (const id of [f.person.id, f.secret.id, f.formula.id, f.table.id, f.form.id]) {
      expect(text).not.toContain(id);
    }
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('creates the record as the Form actor and answers nothing about it', async () => {
    const f = await fixture();
    const res = await submit(f.token, {
      [f.name.id]: 'Login broken',
      [f.kind.id]: 'Bug',
      [f.details.id]: 'It spins forever',
      [f.age.id]: '42',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ submitted: true });
    const [record] = await records(f.table.id);
    expect(record?.fields).toMatchObject({
      [f.name.id]: 'Login broken',
      [f.kind.id]: 'bug',
      [f.details.id]: 'It spins forever',
      [f.age.id]: 42,
      [f.formula.id]: 2,
    });
    expect(record?.createdBy).toBeNull();
    const { revisions } = await ok<{ revisions: Revision[] }>(
      await asOwner('GET', `/api/tables/${f.table.id}/records/${record?.id}/revisions`)
    );
    expect(revisions[0]).toMatchObject({ kind: 'created', actorId: null, via: 'form' });
    const events = await t.db.select().from(outbox).where(eq(outbox.tableId, f.table.id));
    expect(events.some((e) => e.kind === 'record.created' && e.actorId === null)).toBe(true);
  });

  it('refuses mass assignment: extra fields, record ids, computed fields and createdBy (H4)', async () => {
    const f = await fixture();
    const name = { [f.name.id]: 'Hi' };
    // Top-level keys outside the schema: strict.
    for (const extra of [
      { id: uuidv7() },
      { createdBy: owner.id },
      { records: [{ fields: name }] },
      { tableId: f.table.id },
    ]) {
      const res = await submit(f.token, name, extra);
      expect(res.status, JSON.stringify(extra)).toBe(422);
    }
    // Field keys outside the form's allowlist.
    expect(await problemPaths(await submit(f.token, { ...name, [f.secret.id]: 'x' }))).toEqual([
      `fields.${f.secret.id}`,
    ]);
    expect(await problemPaths(await submit(f.token, { ...name, [f.formula.id]: 3 }))).toEqual([
      `fields.${f.formula.id}`,
    ]);
    expect(
      await problemPaths(await submit(f.token, { ...name, [f.person.id]: [owner.id] }))
    ).toEqual([`fields.${f.person.id}`]);
    expect(await problemPaths(await submit(f.token, { ...name, [uuidv7()]: 'x' }))).toHaveLength(1);
    // Non-uuid keys (createdBy, id) inside `fields` are refused by the schema.
    for (const key of ['createdBy', 'id', 'created_by', 'version']) {
      expect((await submit(f.token, { ...name, [key]: owner.id })).status, key).toBe(422);
    }
    expect(await records(f.table.id)).toHaveLength(0);
  });

  it('checks conditions, required answers and values per type', async () => {
    const f = await fixture();
    // Details shows only for bugs: an answer while it is hidden is refused.
    expect(
      await problemPaths(
        await submit(f.token, { [f.name.id]: 'A', [f.kind.id]: 'idea', [f.details.id]: 'x' })
      )
    ).toEqual([`fields.${f.details.id}`]);
    // Shown and required: an answer is needed.
    expect(
      await problemPaths(await submit(f.token, { [f.name.id]: 'A', [f.kind.id]: 'bug' }))
    ).toEqual([`fields.${f.details.id}`]);
    // The primary field is required.
    expect(await problemPaths(await submit(f.token, { [f.age.id]: 3 }))).toEqual([
      `fields.${f.name.id}`,
    ]);
    // Values the registry can't read.
    expect(
      await problemPaths(await submit(f.token, { [f.name.id]: 'A', [f.age.id]: 'lots' }))
    ).toEqual([`fields.${f.age.id}`]);
    expect(
      await problemPaths(await submit(f.token, { [f.name.id]: 'A', [f.kind.id]: 'Nope' }))
    ).toEqual([`fields.${f.kind.id}`]);
    expect(await records(f.table.id)).toHaveLength(0);
    expect((await submit(f.token, { [f.name.id]: 'A', [f.kind.id]: 'idea' })).status).toBe(201);
    expect(await records(f.table.id)).toHaveLength(1);
  });

  it('creates one record per submissionId (double submits)', async () => {
    const f = await fixture();
    const body = { submissionId: uuidv7(), fields: { [f.name.id]: 'Once' } };
    const results = await Promise.all(
      [1, 2, 3].map(() => request(app, 'POST', `/api/forms/${f.token}/submissions`, body))
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(await records(f.table.id)).toHaveLength(1);
    const rows = await t.db
      .select()
      .from(formSubmissions)
      .where(eq(formSubmissions.tableId, f.table.id));
    expect(rows).toHaveLength(1);
  });

  it('drops fields the edit permissions keep from editors, and refuses them', async () => {
    const f = await fixture((x) => ({
      fields: [{ fieldId: x.name.id }, { fieldId: x.secret.id }],
    }));
    await ok(
      await asOwner('PATCH', `/api/fields/${f.secret.id}`, {
        permissions: { edit: { level: 'creators' } },
      })
    );
    const form = await ok<PublicForm>(await request(app, 'GET', `/api/forms/${f.token}`));
    expect(form.fields.map((x) => x.id)).toEqual([f.name.id]);
    expect(
      await problemPaths(await submit(f.token, { [f.name.id]: 'A', [f.secret.id]: 'x' }))
    ).toEqual([`fields.${f.secret.id}`]);
  });

  it('is 404 for unknown, malformed and revoked tokens, and for read-only links', async () => {
    const f = await fixture();
    const shares = await ok<{ shares: { id: string; kind: string }[] }>(
      await asOwner('GET', `/api/views/${f.form.id}/shares`)
    );
    expect(shares.shares[0]?.kind).toBe('form');
    // A form token opens nothing under /api/shared, and a view link's token no form.
    expect((await request(app, 'GET', `/api/shared/${f.token}`)).status).toBe(404);
    const grid = await ok<ViewMeta>(
      await asOwner('POST', `/api/tables/${f.table.id}/views`, { name: 'G', type: 'grid' }),
      201
    );
    const viewLink = await ok<CreatedShare>(
      await asOwner('POST', `/api/views/${grid.id}/shares`, {}),
      201
    );
    expect((await request(app, 'GET', `/api/forms/${viewLink.token}`)).status).toBe(404);
    expect((await submit(viewLink.token, { [f.name.id]: 'A' })).status).toBe(404);
    expect((await request(app, 'GET', `/api/forms/${'x'.repeat(43)}`)).status).toBe(404);
    expect((await request(app, 'GET', '/api/forms/short')).status).toBe(404);
    const revoked = await asOwner(
      'DELETE',
      `/api/views/${f.form.id}/shares/${shares.shares[0]?.id}`
    );
    expect(revoked.status).toBe(204);
    expect((await submit(f.token, { [f.name.id]: 'A' })).status).toBe(404);
    expect(await records(f.table.id)).toHaveLength(0);
  });

  it('refuses form links with a password, domains, downloads or embeds', async () => {
    const f = await fixture();
    for (const body of [
      { password: 'long enough password' },
      { allowedDomains: ['example.com'] },
      { allowDownload: true },
      { embedOrigins: ['https://example.com'] },
    ]) {
      const res = await asOwner('POST', `/api/views/${f.form.id}/shares`, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
  });

  it('caps the body size', async () => {
    const f = await fixture();
    const res = await submit(f.token, { [f.name.id]: 'x'.repeat(300 * 1024) });
    expect(res.status).toBe(413);
  });

  it('rate-limits submissions per form and IP (429)', async () => {
    const limited = testApp({
      db: t.appDb,
      config: { s3: s3(), formSubmitRateLimit: 2, trustProxy: true },
    });
    const f = await fixture();
    const from = (ip: string) => ({ 'x-forwarded-for': ip });
    const post = (ip: string) =>
      request(
        limited,
        'POST',
        `/api/forms/${f.token}/submissions`,
        { submissionId: uuidv7(), fields: { [f.name.id]: 'A' } },
        from(ip)
      );
    expect((await post('203.0.113.1')).status).toBe(201);
    expect((await post('203.0.113.1')).status).toBe(201);
    const third = await post('203.0.113.1');
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBeTruthy();
    // Another IP still gets through.
    expect((await post('203.0.113.2')).status).toBe(201);
    expect(await records(f.table.id)).toHaveLength(3);
  });

  describe('with a CAPTCHA', () => {
    const seen: string[] = [];
    // Stands in for Cloudflare: Turnstile's dummy token passes, anything else fails.
    const captcha: CaptchaVerifier = async ({ token }) => {
      seen.push(token);
      return token === 'XXXX.DUMMY.TOKEN.XXXX';
    };
    let guarded: ReturnType<typeof testApp>;
    beforeAll(() => {
      guarded = testApp({
        db: t.appDb,
        config: {
          s3: s3(),
          turnstile: {
            secretKey: '1x0000000000000000000000000000000AA',
            siteKey: '1x00000000000000000000AA',
          },
        },
        captcha,
      });
    });

    it('gives the site key and refuses missing or bad tokens before any write', async () => {
      const f = await fixture();
      const form = await ok<PublicForm>(await request(guarded, 'GET', `/api/forms/${f.token}`));
      expect(form.captchaSiteKey).toBe('1x00000000000000000000AA');
      const fields = { [f.name.id]: 'A' };
      const none = await submit(f.token, fields, {}, guarded);
      expect(none.status).toBe(403);
      expect(((await none.json()) as { code: string }).code).toBe('CAPTCHA_FAILED');
      const bad = await submit(f.token, fields, { captchaToken: 'forged' }, guarded);
      expect(bad.status).toBe(403);
      expect(await records(f.table.id)).toHaveLength(0);
      const good = await submit(
        f.token,
        fields,
        { captchaToken: 'XXXX.DUMMY.TOKEN.XXXX' },
        guarded
      );
      expect(good.status).toBe(201);
      expect(await records(f.table.id)).toHaveLength(1);
      // The secret never shows in what the app logged.
      expect(JSON.stringify(guarded.logs)).not.toContain('1x0000000000000000000000000000000AA');
    });
  });

  it('refuses to publish or serve forms in production without Turnstile keys', async () => {
    const f = await fixture();
    const prod = testApp({
      db: t.appDb,
      config: { s3: s3(), isProduction: true, turnstile: undefined },
    });
    expect((await request(prod, 'GET', `/api/forms/${f.token}`)).status).toBe(503);
    expect((await submit(f.token, { [f.name.id]: 'A' }, {}, prod)).status).toBe(503);
    const cookie = await createSession(t.db, owner);
    const res = await request(
      prod,
      'POST',
      `/api/views/${f.form.id}/shares`,
      {},
      {
        cookie: `${SESSION_COOKIE}=${cookie}`,
      }
    );
    expect(res.status).toBe(503);
  });

  describe('uploads', () => {
    async function upload(token: string, fieldId: string, bytes = new Uint8Array([1, 2, 3])) {
      const { attachment, upload } = await ok<AttachmentUpload>(
        await request(app, 'POST', `/api/forms/${token}/attachments`, {
          fieldId,
          filename: 'notes.txt',
          type: 'text/plain',
          size: bytes.byteLength,
        }),
        201
      );
      const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: bytes });
      if (!put.ok) throw new Error(`PUT ${put.status}`);
      return ok<AttachmentValue>(
        await request(app, 'POST', `/api/forms/${token}/attachments/${attachment.id}/confirm`)
      );
    }

    it('attaches a form upload to the new record, once', async () => {
      const f = await fixture();
      const file = await upload(f.token, f.files.id);
      const fields = { [f.name.id]: 'With file', [f.files.id]: [file] };
      expect((await submit(f.token, fields)).status).toBe(201);
      const [record] = await records(f.table.id);
      expect(record?.fields[f.files.id]).toEqual([
        expect.objectContaining({ id: file.id, filename: 'notes.txt', size: 3 }),
      ]);
      const [row] = await t.db.select().from(attachments).where(eq(attachments.id, file.id));
      expect(row?.recordId).toBe(record?.id);
      // Used once: a second submission can't attach it again.
      expect(await problemPaths(await submit(f.token, fields))).toEqual([`fields.${f.files.id}`]);
    });

    it("refuses other files: the base's, another form's, made-up ids, other fields", async () => {
      const f = await fixture();
      const other = await fixture();
      const theirs = await upload(other.token, other.files.id);
      // A file uploaded by an editor for a cell of this table.
      const { attachment } = await ok<AttachmentUpload>(
        await asOwner('POST', `/api/tables/${f.table.id}/attachments`, {
          fieldId: f.files.id,
          filename: 'secret.pdf',
          type: 'application/pdf',
          size: 3,
        }),
        201
      );
      for (const file of [theirs, { ...theirs, id: attachment.id }, { ...theirs, id: uuidv7() }]) {
        const res = await submit(f.token, { [f.name.id]: 'A', [f.files.id]: [file] });
        expect(await problemPaths(res)).toEqual([`fields.${f.files.id}`]);
      }
      // Uploads only for an attachment field on the form.
      const wrong = await request(app, 'POST', `/api/forms/${f.token}/attachments`, {
        fieldId: f.details.id,
        filename: 'x.txt',
        type: 'text/plain',
        size: 1,
      });
      expect(wrong.status).toBe(422);
      // Another form's file can't be confirmed through this link either.
      const confirm = await request(
        app,
        'POST',
        `/api/forms/${f.token}/attachments/${theirs.id}/confirm`
      );
      expect(confirm.status).toBe(404);
      // An unsubmitted form upload isn't usable in an editor's cell write.
      const pending = await upload(f.token, f.files.id);
      const res = await asOwner('POST', `/api/tables/${f.table.id}/records`, {
        records: [{ fields: { [f.files.id]: [pending] } }],
      });
      expect(res.status).toBe(422);
    });

    it('caps the size of a form upload', async () => {
      const f = await fixture();
      const res = await request(app, 'POST', `/api/forms/${f.token}/attachments`, {
        fieldId: f.files.id,
        filename: 'big.bin',
        type: 'application/octet-stream',
        size: 21 * 1024 * 1024,
      });
      expect(res.status).toBe(422);
    });
  });

  it('lets only creators and owners publish a form', async () => {
    const f = await fixture();
    const user = await addMember(t.db, workspaceId, 'editor');
    const cookie = await createSession(t.db, user);
    const res = await request(
      app,
      'POST',
      `/api/views/${f.form.id}/shares`,
      {},
      {
        cookie: `${SESSION_COOKIE}=${cookie}`,
      }
    );
    expect(res.status).toBe(403);
  });
});

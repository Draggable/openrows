import type {
  AttachmentUpload,
  AttachmentValue,
  FieldMeta,
  FormLayout,
  RecordData,
  TableMeta,
  ViewMeta,
} from '@openrows/shared';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import type { users } from '../../src/db/index.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createWorkspace } from '../helpers/factories.js';
import { useTestS3 } from '../helpers/s3.js';

/**
 * The form view builder's config: a new form starts with the writable fields; `form`
 * layouts are checked on write (unknown, computed and repeated fields, conditions on fields
 * that aren't above, condition operators, https-only redirects, cover and logo images uploaded
 * for a form view of the table) and pruned on read.
 */
describe('form views', () => {
  const t = useTestDb();
  const s3 = useTestS3();
  let owner: typeof users.$inferSelect;
  let workspaceId: string;
  let app: ReturnType<typeof testApp>;
  let ownerCookie: string;
  let png: Buffer;

  const request = (method: string, path: string, body?: unknown, cookie = ownerCookie) =>
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

  const problems = async (res: Response) => {
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors?: { path: string; message: string }[] };
    return (body.errors ?? []).map((e) => e.path).sort();
  };

  type Fixture = {
    baseId: string;
    table: TableMeta;
    name: FieldMeta;
    kind: FieldMeta;
    details: FieldMeta;
    age: FieldMeta;
    files: FieldMeta;
    formula: FieldMeta;
    auto: FieldMeta;
    created: FieldMeta;
    button: FieldMeta;
  };

  async function fixture(cookie = ownerCookie): Promise<Fixture> {
    const base = await ok<{ id: string }>(
      await request('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Base' }, cookie),
      201
    );
    const table = await ok<TableMeta>(
      await request('POST', `/api/bases/${base.id}/tables`, { name: 'Requests' }, cookie),
      201
    );
    const field = async (body: unknown) =>
      ok<FieldMeta>(await request('POST', `/api/tables/${table.id}/fields`, body, cookie), 201);
    const name = table.fields.find((f) => f.isPrimary);
    if (!name) throw new Error('no primary field');
    return {
      baseId: base.id,
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
      auto: await field({ name: 'No', type: 'autoNumber' }),
      created: await field({ name: 'Created', type: 'createdTime' }),
      button: await field({ name: 'Open', type: 'button' }),
    };
  }

  const newView = async (tableId: string, type: string, extra: object = {}) =>
    ok<ViewMeta>(
      await request('POST', `/api/tables/${tableId}/views`, {
        name: `${type} ${Math.random().toString(36).slice(2)}`,
        type,
        ...extra,
      }),
      201
    );

  const patchForm = (viewId: string, form: FormLayout, cookie = ownerCookie) =>
    request('PATCH', `/api/views/${viewId}`, { form }, cookie);

  async function uploadImage(
    tableId: string,
    owner: { viewId: string } | { fieldId: string },
    bytes: Uint8Array = png,
    type = 'image/png'
  ): Promise<AttachmentValue> {
    const { attachment, upload } = await ok<AttachmentUpload>(
      await request(
        'POST',
        `/api/tables/${tableId}/attachments`,
        { ...owner, filename: 'cover.png', type, size: bytes.byteLength },
        ownerCookie
      ),
      201
    );
    const res = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: bytes });
    if (!res.ok) throw new Error(`PUT ${res.status}`);
    return ok<AttachmentValue>(
      await request('POST', `/api/tables/${tableId}/attachments/${attachment.id}/confirm`)
    );
  }

  beforeAll(async () => {
    const created = await createWorkspace(t.db);
    owner = created.owner;
    workspaceId = created.workspace.id;
    app = testApp({ db: t.appDb, config: { s3: s3() } });
    ownerCookie = await createSession(t.db, owner);
    png = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#146C55' } })
      .png()
      .toBuffer();
  });

  it('starts a new form with every field a form can hold, the primary field first', async () => {
    const f = await fixture();
    const form = await newView(f.table.id, 'form');
    expect(form.type).toBe('form');
    const ids = form.config.form?.fields?.map((x) => x.fieldId) ?? [];
    expect(ids[0]).toBe(f.name.id);
    for (const w of [f.kind, f.details, f.age, f.files]) expect(ids).toContain(w.id);
    for (const c of [f.formula, f.auto, f.created, f.button]) expect(ids).not.toContain(c.id);
    // In field order.
    expect(ids.indexOf(f.kind.id)).toBeLessThan(ids.indexOf(f.files.id));
  });

  it('saves a full layout and answers it', async () => {
    const f = await fixture();
    const form = await newView(f.table.id, 'form');
    const layout: FormLayout = {
      title: 'Report a problem',
      description: 'Tell us **what** happened.',
      submitLabel: 'Send',
      afterSubmit: 'redirect',
      redirectUrl: 'https://example.com/thanks',
      submitMessage: 'Thanks!',
      showBranding: false,
      fields: [
        { fieldId: f.kind.id, required: true, label: 'What is it?' },
        {
          fieldId: f.details.id,
          helpText: 'Steps to reproduce',
          allowPrefill: true,
          condition: {
            conjunction: 'and',
            conditions: [{ fieldId: f.kind.id, operator: 'is', value: 'bug' }],
          },
        },
        { fieldId: f.name.id },
      ],
    };
    const saved = await ok<ViewMeta>(await patchForm(form.id, layout));
    expect(saved.config.form).toEqual(layout);
    // A patch replaces only the keys it names.
    const again = await ok<ViewMeta>(await patchForm(form.id, { title: 'Bugs' }));
    expect(again.config.form).toEqual({ ...layout, title: 'Bugs' });
  });

  it('refuses unknown, computed, automatic, button and repeated fields', async () => {
    const f = await fixture();
    const form = await newView(f.table.id, 'form');
    const res = await patchForm(form.id, {
      fields: [
        { fieldId: f.name.id },
        { fieldId: '01900000-0000-7000-8000-000000000000' },
        { fieldId: f.formula.id },
        { fieldId: f.auto.id },
        { fieldId: f.created.id },
        { fieldId: f.button.id },
        { fieldId: f.name.id },
      ],
    });
    expect(await problems(res)).toEqual([
      'form.fields.1.fieldId',
      'form.fields.2.fieldId',
      'form.fields.3.fieldId',
      'form.fields.4.fieldId',
      'form.fields.5.fieldId',
      'form.fields.6.fieldId',
    ]);
    // A field of another table is unknown here.
    const other = await fixture();
    expect(
      await problems(await patchForm(form.id, { fields: [{ fieldId: other.name.id }] }))
    ).toEqual(['form.fields.0.fieldId']);
  });

  it('needs condition fields to exist above the conditioned field, with valid operators', async () => {
    const f = await fixture();
    const form = await newView(f.table.id, 'form');
    const cond = (fieldId: string, operator = 'isNotEmpty', value?: unknown) => ({
      conjunction: 'and' as const,
      conditions: [
        {
          fieldId,
          operator: operator as 'isNotEmpty',
          ...(value === undefined ? {} : { value }),
        },
      ],
    });
    // Below it, not on the form, not in the table, itself.
    expect(
      await problems(
        await patchForm(form.id, {
          fields: [
            { fieldId: f.name.id, condition: cond(f.kind.id) },
            { fieldId: f.kind.id },
            { fieldId: f.details.id, condition: cond(f.age.id) },
            { fieldId: f.age.id, condition: cond('01900000-0000-7000-8000-000000000000') },
            { fieldId: f.files.id, condition: cond(f.files.id) },
          ],
        })
      )
    ).toEqual([
      'form.fields.0.condition.conditions.0.fieldId',
      'form.fields.2.condition.conditions.0.fieldId',
      'form.fields.3.condition.conditions.0.fieldId',
      'form.fields.4.condition.conditions.0.fieldId',
    ]);
    // An operator the field's type doesn't offer, or a value it can't read.
    expect(
      await problems(
        await patchForm(form.id, {
          fields: [
            { fieldId: f.kind.id },
            { fieldId: f.age.id },
            { fieldId: f.details.id, condition: cond(f.kind.id, '>', 3) },
            { fieldId: f.name.id, condition: cond(f.age.id, '>', 'many') },
          ],
        })
      )
    ).toEqual(['form.fields.2.condition.conditions.0', 'form.fields.3.condition.conditions.0']);
    // Nested groups are checked too.
    expect(
      await problems(
        await patchForm(form.id, {
          fields: [
            { fieldId: f.kind.id },
            {
              fieldId: f.details.id,
              condition: {
                conjunction: 'or',
                conditions: [
                  { conjunction: 'and', conditions: [{ fieldId: f.age.id, operator: 'isEmpty' }] },
                ],
              },
            },
          ],
        })
      )
    ).toEqual(['form.fields.1.condition.conditions.0.conditions.0.fieldId']);
  });

  it('redirects to https URLs only, and needs one to redirect', async () => {
    const f = await fixture();
    const form = await newView(f.table.id, 'form');
    for (const url of [
      'http://example.com',
      'javascript:alert(1)',
      '/thanks',
      'https://a:b@x.io',
    ]) {
      const res = await patchForm(form.id, { afterSubmit: 'redirect', redirectUrl: url });
      expect(await problems(res), url).toEqual(['form.redirectUrl']);
    }
    expect(await problems(await patchForm(form.id, { afterSubmit: 'redirect' }))).toEqual([
      'form.redirectUrl',
    ]);
    await ok(await patchForm(form.id, { afterSubmit: 'redirect', redirectUrl: 'https://x.io' }));
    // Clearing the URL while redirecting is refused; switching to a message first isn't.
    expect(await problems(await patchForm(form.id, { redirectUrl: null }))).toEqual([
      'form.redirectUrl',
    ]);
    await ok(await patchForm(form.id, { afterSubmit: 'message', redirectUrl: null }));
  });

  it('keeps form layouts to form views', async () => {
    const f = await fixture();
    const grid = await newView(f.table.id, 'grid');
    expect(await problems(await patchForm(grid.id, { title: 'x' }))).toEqual(['form']);
  });

  it('prunes deleted fields and the conditions on them on read', async () => {
    const f = await fixture();
    const form = await newView(f.table.id, 'form');
    await ok(
      await patchForm(form.id, {
        fields: [
          { fieldId: f.age.id },
          {
            fieldId: f.details.id,
            condition: {
              conjunction: 'and',
              conditions: [{ fieldId: f.age.id, operator: '>', value: 1 }],
            },
          },
        ],
      })
    );
    const del = await request('DELETE', `/api/fields/${f.age.id}`);
    expect(del.status).toBeLessThan(300);
    const read = await ok<ViewMeta>(await request('GET', `/api/views/${form.id}`));
    expect(read.config.form?.fields).toEqual([{ fieldId: f.details.id, condition: null }]);
    // A deleted field can't be added again.
    expect(await problems(await patchForm(form.id, { fields: [{ fieldId: f.age.id }] }))).toEqual([
      'form.fields.0.fieldId',
    ]);
    // The stored layout still names it, and other keys still save.
    await ok(await patchForm(form.id, { title: 'Still fine' }));
  });

  it('takes a cover and logo uploaded for a form view of the table, as images only', async () => {
    const f = await fixture();
    const form = await newView(f.table.id, 'form');
    const cover = await uploadImage(f.table.id, { viewId: form.id });
    const logo = await uploadImage(f.table.id, { viewId: form.id });
    const saved = await ok<ViewMeta>(
      await patchForm(form.id, { coverAttachmentId: cover.id, logoAttachmentId: logo.id })
    );
    expect(saved.config.form?.coverAttachmentId).toBe(cover.id);
    // The cover downloads like any file of the table.
    const dl = await request('GET', `/api/tables/${f.table.id}/attachments/${cover.id}`);
    expect(dl.status).toBe(302);
    // A duplicate keeps the original's images, and may set them again.
    const copy = await ok<ViewMeta>(
      await request('POST', `/api/views/${form.id}/duplicate`, {}),
      201
    );
    await ok(await patchForm(copy.id, { coverAttachmentId: cover.id }));
    await ok(await patchForm(form.id, { coverAttachmentId: null }));

    // A cell's file, an unknown id and a file of another table aren't form images.
    const record = (
      await ok<{ records: RecordData[] }>(
        await request('POST', `/api/tables/${f.table.id}/records`, { records: [{ fields: {} }] }),
        201
      )
    ).records[0];
    const cellFile = await uploadImage(f.table.id, { fieldId: f.files.id });
    const other = await fixture();
    const otherForm = await newView(other.table.id, 'form');
    const otherCover = await uploadImage(other.table.id, { viewId: otherForm.id });
    for (const id of [cellFile.id, otherCover.id, '01900000-0000-7000-8000-000000000000']) {
      expect(await problems(await patchForm(form.id, { logoAttachmentId: id }))).toEqual([
        'form.logoAttachmentId',
      ]);
    }
    // And a form image isn't a cell's file.
    const cell = await request('PATCH', `/api/tables/${f.table.id}/records/${record?.id}`, {
      fields: { [f.files.id]: [{ id: cover.id }] },
    });
    expect(cell.status).toBe(422);
  });

  it('announces form images only for a visible form view of the table, as raster images', async () => {
    const f = await fixture();
    const form = await newView(f.table.id, 'form');
    const grid = await newView(f.table.id, 'grid');
    const other = await fixture();
    const announce = (body: object, cookie = ownerCookie) =>
      request(
        'POST',
        `/api/tables/${f.table.id}/attachments`,
        { filename: 'x.png', type: 'image/png', size: 10, ...body },
        cookie
      );
    expect(await problems(await announce({ viewId: grid.id }))).toEqual(['viewId']);
    const otherForm = await newView(other.table.id, 'form');
    expect(await problems(await announce({ viewId: otherForm.id }))).toEqual(['viewId']);
    expect(
      await problems(await announce({ viewId: form.id, type: 'image/svg+xml', filename: 'x.svg' }))
    ).toEqual(['type']);
    expect(await problems(await announce({ viewId: form.id, fieldId: f.files.id }))).toEqual([
      'fieldId',
    ]);
    // Another editor's personal form is no view of theirs.
    const editor = await addMember(t.db, workspaceId, 'editor');
    const editorCookie = await createSession(t.db, editor);
    const personal = await newView(f.table.id, 'form', { personal: true });
    expect(await problems(await announce({ viewId: personal.id }, editorCookie))).toEqual([
      'viewId',
    ]);
    expect((await announce({ viewId: form.id }, editorCookie)).status).toBe(201);
  });

  it('lets editors change an unlocked form, and only creators a locked one', async () => {
    const f = await fixture();
    const form = await newView(f.table.id, 'form');
    const editor = await addMember(t.db, workspaceId, 'editor');
    const editorCookie = await createSession(t.db, editor);
    await ok(await patchForm(form.id, { title: 'By an editor' }, editorCookie));
    await ok(await request('PATCH', `/api/views/${form.id}`, { locked: true }));
    expect((await patchForm(form.id, { title: 'Again' }, editorCookie)).status).toBe(403);
    const reader = await addMember(t.db, workspaceId, 'read_only');
    const readerCookie = await createSession(t.db, reader);
    expect((await patchForm(form.id, { title: 'No' }, readerCookie)).status).toBe(403);
  });
});

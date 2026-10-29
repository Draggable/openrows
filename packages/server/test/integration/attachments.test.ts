import type {
  AttachmentUpload,
  AttachmentValue,
  FieldMeta,
  RecordData,
  StorageUsage,
  TableMeta,
} from '@openrows/shared';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { S3ObjectStore, UnknownObjectSizeError } from '../../src/attachments/storage.js';
import { makeThumbnail } from '../../src/attachments/thumbnails.js';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { baseMembers, type users } from '../../src/db/index.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createUser, createWorkspace } from '../helpers/factories.js';
import { useTestS3 } from '../helpers/s3.js';

/**
 * Attachments through the API as openrows_app against a real S3 server (Versity): the
 * presigned upload, the confirmation, the cell write, signed downloads, thumbnails and storage
 * accounting, plus a security test for each legacy finding: H5 (a cross-tenant key or file id),
 * M1 (user files served inline: HTML and SVG) and M7 (base roles ignored).
 */
describe('attachments', () => {
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

  /** A table in a new base of `wsId` with an attachment field "Files" and one record. */
  async function newTable(wsId = workspaceId, cookie = ownerCookie) {
    const base = await ok<{ id: string }>(
      await request('POST', `/api/workspaces/${wsId}/bases`, { name: 'Base' }, cookie),
      201
    );
    const table = await ok<TableMeta>(
      await request('POST', `/api/bases/${base.id}/tables`, { name: 'Tasks' }, cookie),
      201
    );
    const field = await ok<FieldMeta>(
      await request(
        'POST',
        `/api/tables/${table.id}/fields`,
        { name: 'Files', type: 'attachment' },
        cookie
      ),
      201
    );
    const created = await ok<{ records: RecordData[] }>(
      await request(
        'POST',
        `/api/tables/${table.id}/records`,
        { records: [{ fields: {} }] },
        cookie
      ),
      201
    );
    const record = created.records[0];
    if (!record) throw new Error('no record');
    return { baseId: base.id, table, field, record };
  }

  async function announce(
    tableId: string,
    body: Record<string, unknown>,
    cookie = ownerCookie
  ): Promise<AttachmentUpload> {
    return ok(await request('POST', `/api/tables/${tableId}/attachments`, body, cookie), 201);
  }

  const put = (upload: AttachmentUpload['upload'], bytes: Uint8Array) =>
    fetch(upload.url, { method: 'PUT', headers: upload.headers, body: bytes });

  const confirm = (tableId: string, id: string, cookie = ownerCookie) =>
    request('POST', `/api/tables/${tableId}/attachments/${id}/confirm`, undefined, cookie);

  /** Announces, uploads and confirms a file; answers its value. */
  async function upload(
    tableId: string,
    fieldId: string,
    bytes: Uint8Array,
    filename: string,
    type: string,
    cookie = ownerCookie
  ): Promise<AttachmentValue> {
    const { attachment, upload: target } = await announce(
      tableId,
      { fieldId, filename, type, size: bytes.byteLength },
      cookie
    );
    const res = await put(target, bytes);
    if (!res.ok) throw new Error(`PUT ${res.status}: ${await res.text()}`);
    return ok<AttachmentValue>(await confirm(tableId, attachment.id, cookie));
  }

  const setCell = (tableId: string, recordId: string, fieldId: string, value: unknown) =>
    request('PATCH', `/api/tables/${tableId}/records/${recordId}`, {
      fields: { [fieldId]: value },
    });

  /** Follows the API's redirect to the signed URL and fetches the file from S3. */
  async function download(path: string, cookie = ownerCookie) {
    const res = await request('GET', path, undefined, cookie);
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    return { location, file: await fetch(location) };
  }

  beforeAll(async () => {
    const created = await createWorkspace(t.db);
    owner = created.owner;
    workspaceId = created.workspace.id;
    app = testApp({ db: t.appDb, config: { s3: s3() } });
    ownerCookie = await createSession(t.db, owner);
    png = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: '#146C55' },
    })
      .png()
      .toBuffer();
  });

  it('uploads an image, writes it into a cell with the server metadata and thumbnails it', async () => {
    const { table, field, record } = await newTable();
    const announced = await announce(table.id, {
      fieldId: field.id,
      filename: 'photo.png',
      type: 'image/png',
      size: png.byteLength,
    });
    // The server picks the key: the workspace, base and table prefix, then the attachment id.
    const url = new URL(announced.upload.url);
    expect(url.pathname).toBe(
      `/openrows/ws/${workspaceId}/b/${table.baseId}/t/${table.id}/${announced.attachment.id}`
    );
    expect(Number(url.searchParams.get('X-Amz-Expires'))).toBe(15 * 60);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
    expect((await put(announced.upload, png)).status).toBe(200);
    const value = await ok<AttachmentValue>(await confirm(table.id, announced.attachment.id));
    expect(value).toEqual({
      id: announced.attachment.id,
      filename: 'photo.png',
      size: png.byteLength,
      type: 'image/png',
    });

    // The client's metadata is replaced by the stored one.
    const written = await ok<RecordData>(
      await setCell(table.id, record.id, field.id, [
        { ...value, filename: 'evil.html', size: 1, type: 'text/html' },
      ])
    );
    expect(written.fields[field.id]).toEqual([value]);

    // The job makes a 512 px WebP (the disguised-SVG test covers the fallback to the image).
    await app.thumbnails.idle();
    const thumb = await download(`/api/tables/${table.id}/attachments/${value.id}/thumbnail`);
    expect(thumb.file.status).toBe(200);
    expect(thumb.file.headers.get('content-type')).toBe('image/webp');
    expect(thumb.file.headers.get('content-disposition')).toMatch(/^inline;/);
    const meta = await sharp(Buffer.from(await thumb.file.arrayBuffer())).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 512, 341]);

    // Written again, the cell now carries the image's size.
    const again = await ok<RecordData>(await setCell(table.id, record.id, field.id, [value]));
    expect(again.fields[field.id]).toEqual([{ ...value, width: 1200, height: 800 }]);

    const original = await download(`/api/tables/${table.id}/attachments/${value.id}`);
    expect(original.file.headers.get('content-type')).toBe('image/png');
    expect(original.file.headers.get('content-disposition')).toBe(
      `inline; filename="photo.png"; filename*=UTF-8''photo.png`
    );
    expect(Buffer.from(await original.file.arrayBuffer()).equals(png)).toBe(true);
  });

  it('counts confirmed files and thumbnails per workspace', async () => {
    const { workspace, owner: other } = await createWorkspace(t.db);
    const cookie = await createSession(t.db, other);
    const { table, field } = await newTable(workspace.id, cookie);
    const empty = await ok<StorageUsage>(
      await request('GET', `/api/workspaces/${workspace.id}/storage`, undefined, cookie)
    );
    expect(empty).toEqual({ workspaceId: workspace.id, files: 0, bytes: 0 });
    await upload(table.id, field.id, new Uint8Array(1000), 'a.bin', '', cookie);
    // Announced but never uploaded: not counted.
    await announce(table.id, { fieldId: field.id, filename: 'b.bin', size: 50 }, cookie);
    await upload(table.id, field.id, png, 'c.png', 'image/png', cookie);
    await app.thumbnails.idle();
    const used = await ok<StorageUsage>(
      await request('GET', `/api/workspaces/${workspace.id}/storage`, undefined, cookie)
    );
    expect(used.files).toBe(2);
    expect(used.bytes).toBeGreaterThan(1000 + png.byteLength);
  });

  describe('H5: keys and file ids never cross tenants', () => {
    it("refuses another workspace's file id in confirm, download and cell writes", async () => {
      const mine = await newTable();
      const { workspace, owner: other } = await createWorkspace(t.db);
      const otherCookie = await createSession(t.db, other);
      const theirs = await newTable(workspace.id, otherCookie);
      const file = await upload(mine.table.id, mine.field.id, png, 'mine.png', 'image/png');

      // Through their own table: the file isn't in it (404, not a leak).
      expect((await confirm(theirs.table.id, file.id, otherCookie)).status).toBe(404);
      const res = await request(
        'GET',
        `/api/tables/${theirs.table.id}/attachments/${file.id}`,
        undefined,
        otherCookie
      );
      expect(res.status).toBe(404);
      // Through mine: they have no role on it.
      expect((await confirm(mine.table.id, file.id, otherCookie)).status).toBe(404);
      // Writing my file id into their cell.
      const write = await request(
        'PATCH',
        `/api/tables/${theirs.table.id}/records/${theirs.record.id}`,
        { fields: { [theirs.field.id]: [file] } },
        otherCookie
      );
      expect(write.status).toBe(422);
      expect(JSON.stringify(await write.json())).toContain('No uploaded file');
    });

    it('refuses files of another base, unconfirmed files and made-up ids in cells', async () => {
      const a = await newTable();
      const b = await newTable();
      const fromB = await upload(b.table.id, b.field.id, png, 'b.png', 'image/png');
      const pending = await announce(a.table.id, {
        fieldId: a.field.id,
        filename: 'p.png',
        type: 'image/png',
        size: 10,
      });
      for (const value of [
        [fromB],
        [pending.attachment],
        [{ id: '01900000-0000-7000-8000-000000000000', filename: 'x', size: 1, type: 'a/b' }],
        [{ id: 'ws/other/key', filename: 'x', size: 1, type: 'a/b' }],
      ]) {
        expect((await setCell(a.table.id, a.record.id, a.field.id, value)).status).toBe(422);
      }
      // A file of another table in the same base is fine (same people, same roles).
      const sibling = await ok<TableMeta>(
        await request('POST', `/api/bases/${a.baseId}/tables`, { name: 'Other' }),
        201
      );
      const siblingField = await ok<FieldMeta>(
        await request('POST', `/api/tables/${sibling.id}/fields`, {
          name: 'Files',
          type: 'attachment',
        }),
        201
      );
      const fromSibling = await upload(sibling.id, siblingField.id, png, 's.png', 'image/png');
      expect((await setCell(a.table.id, a.record.id, a.field.id, [fromSibling])).status).toBe(200);
    });

    it('only accepts uploads to an attachment field of the table, with the announced size', async () => {
      const { table, field } = await newTable();
      const notes = table.fields.find((f) => f.name === 'Notes');
      const bad = [
        { fieldId: notes?.id, filename: 'a.png', type: 'image/png', size: 10 },
        { fieldId: '01900000-0000-7000-8000-000000000000', filename: 'a', size: 10 },
        { fieldId: field.id, filename: 'big.bin', size: 100 * 1024 * 1024 + 1 },
        { fieldId: field.id, filename: 'a', size: 10, key: 'ws/other/x' },
        { fieldId: field.id, filename: 'a', size: 10, type: 'text/html; charset=utf-8' },
      ];
      for (const body of bad) {
        expect(
          (await request('POST', `/api/tables/${table.id}/attachments`, body)).status,
          JSON.stringify(body)
        ).toBe(422);
      }

      // More (or fewer) bytes than announced don't match the signature.
      const small = await announce(table.id, { fieldId: field.id, filename: 'a.txt', size: 10 });
      expect((await put(small.upload, new Uint8Array(11))).status).toBe(403);
      expect((await put(small.upload, new Uint8Array(9))).status).toBe(403);
      // Not uploaded yet.
      expect((await confirm(table.id, small.attachment.id)).status).toBe(409);

      // An S3 that doesn't enforce the signed length: the confirmation checks it again and drops
      // the object.
      const store = new S3ObjectStore(s3());
      const key = `ws/${workspaceId}/b/${table.baseId}/t/${table.id}/${small.attachment.id}`;
      await store.put(key, new Uint8Array(12), 'application/octet-stream');
      expect((await confirm(table.id, small.attachment.id)).status).toBe(422);
      expect(await store.head(key)).toBeNull();
    });

    it("keeps an upload whose size the store doesn't report, and confirms it on a retry", async () => {
      const { table, field } = await newTable();
      const html = new TextEncoder().encode('<!doctype html><p>compressible</p>');
      const { attachment, upload: target } = await announce(table.id, {
        fieldId: field.id,
        filename: 'page.html',
        type: 'text/html',
        size: html.byteLength,
      });
      expect((await put(target, html)).status).toBe(200);

      // A store (or proxy) that leaves the length out: never a size mismatch, never a delete.
      class Sizeless extends S3ObjectStore {
        override async head(): Promise<{ size: number } | null> {
          throw new UnknownObjectSizeError('no length');
        }
      }
      const sizeless = testApp({
        db: t.appDb,
        config: { s3: s3() },
        objectStore: new Sizeless(s3()),
      });
      const res = await sizeless.app.request(
        `/api/tables/${table.id}/attachments/${attachment.id}/confirm`,
        {
          method: 'POST',
          headers: { origin: sizeless.config.appUrl, cookie: `${SESSION_COOKIE}=${ownerCookie}` },
        }
      );
      expect(res.status).toBe(503);
      expect(((await res.json()) as { detail: string }).detail).toMatch(
        /didn't report the uploaded file's size/
      );

      const store = new S3ObjectStore(s3());
      const key = `ws/${workspaceId}/b/${table.baseId}/t/${table.id}/${attachment.id}`;
      expect(await store.head(key)).toEqual({ size: html.byteLength });
      expect(await store.get(key, 1000)).toEqual(html);
      expect(await ok<AttachmentValue>(await confirm(table.id, attachment.id))).toMatchObject({
        size: html.byteLength,
        type: 'text/html',
      });
    });
  });

  describe('M1: user files never run in the app origin', () => {
    it('downloads HTML, SVG and other files as attachments, and only raster images inline', async () => {
      const { table, field } = await newTable();
      const html = new TextEncoder().encode('<script>alert(document.cookie)</script>');
      const svg = new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
      );
      const cases = [
        { name: 'x.html', type: 'text/html', bytes: html, disposition: 'attachment' },
        { name: 'x.svg', type: 'image/svg+xml', bytes: svg, disposition: 'attachment' },
        { name: 'x.pdf', type: 'application/pdf', bytes: html, disposition: 'attachment' },
        { name: 'x.bin', type: '', bytes: html, disposition: 'attachment' },
        { name: 'ok.png', type: 'image/png', bytes: png, disposition: 'inline' },
      ];
      for (const c of cases) {
        const value = await upload(table.id, field.id, c.bytes, c.name, c.type);
        const { location, file } = await download(
          `/api/tables/${table.id}/attachments/${value.id}`
        );
        expect(new URL(location).searchParams.get('X-Amz-Expires')).toBe('600');
        expect(file.status, c.name).toBe(200);
        expect(file.headers.get('content-disposition'), c.name).toMatch(
          new RegExp(`^${c.disposition}; filename="${c.name.replace('.', '\\.')}"`)
        );
        expect(file.headers.get('content-type'), c.name).toBe(c.type || 'application/octet-stream');
      }
    });

    it('makes no thumbnail of SVG, even declared as PNG, nor of other files', async () => {
      const svg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
      );
      expect(await makeThumbnail(svg)).toBeNull();

      const { table, field } = await newTable();
      const disguised = await upload(table.id, field.id, svg, 'x.png', 'image/png');
      const text = await upload(table.id, field.id, svg, 'x.txt', 'text/plain');
      await app.thumbnails.idle();
      // The disguised one falls back to the original, served as a PNG (an image, never a page).
      const fallback = await download(
        `/api/tables/${table.id}/attachments/${disguised.id}/thumbnail`
      );
      expect(fallback.file.headers.get('content-type')).toBe('image/png');
      const none = await request('GET', `/api/tables/${table.id}/attachments/${text.id}/thumbnail`);
      expect(none.status).toBe(404);
    });

    it('escapes the filename in Content-Disposition', async () => {
      const { table, field } = await newTable();
      const value = await upload(table.id, field.id, png, 'a"b\\c é.png', 'image/png');
      const { file } = await download(`/api/tables/${table.id}/attachments/${value.id}`);
      expect(file.headers.get('content-disposition')).toBe(
        `inline; filename="a_b_c _.png"; filename*=UTF-8''a%22b%5Cc%20%C3%A9.png`
      );
    });
  });

  describe('M7: base roles apply', () => {
    it('keeps a read-only base collaborator from uploading; they can still download', async () => {
      const { baseId, table, field } = await newTable();
      const file = await upload(table.id, field.id, png, 'p.png', 'image/png');
      // A base-only collaborator (base roles raise, never lower, a workspace role).
      const guest = await createUser(t.db);
      const cookie = await createSession(t.db, guest);
      await t.db
        .insert(baseMembers)
        .values({ workspaceId, baseId, userId: guest.id, role: 'read_only' });
      const body = { fieldId: field.id, filename: 'a.txt', size: 5 };
      expect(
        (await request('POST', `/api/tables/${table.id}/attachments`, body, cookie)).status
      ).toBe(403);
      expect((await confirm(table.id, file.id, cookie)).status).toBe(403);
      const res = await request(
        'GET',
        `/api/tables/${table.id}/attachments/${file.id}`,
        undefined,
        cookie
      );
      expect(res.status).toBe(302);
    });

    it('lets a base override make a workspace commenter an uploader in that base only', async () => {
      const a = await newTable();
      const b = await newTable();
      const commenter = await addMember(t.db, workspaceId, 'commenter');
      const cookie = await createSession(t.db, commenter);
      await t.db
        .insert(baseMembers)
        .values({ workspaceId, baseId: a.baseId, userId: commenter.id, role: 'editor' });
      await upload(a.table.id, a.field.id, png, 'p.png', 'image/png', cookie);
      const body = { fieldId: b.field.id, filename: 'a.txt', size: 5 };
      expect(
        (await request('POST', `/api/tables/${b.table.id}/attachments`, body, cookie)).status
      ).toBe(403);
    });
  });

  it("answers 503 when file storage isn't configured", async () => {
    const { table, field } = await newTable();
    const bare = testApp({ db: t.appDb });
    const res = await bare.app.request(`/api/tables/${table.id}/attachments`, {
      method: 'POST',
      headers: {
        origin: bare.config.appUrl,
        cookie: `${SESSION_COOKIE}=${ownerCookie}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ fieldId: field.id, filename: 'a.txt', size: 5 }),
    });
    expect(res.status).toBe(503);
  });
});

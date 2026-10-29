import type {
  CreatedShare,
  FieldMeta,
  SharedRecord,
  SharedView,
  TableMeta,
  ViewMeta,
} from '@openrows/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import {
  createReadyAttachment,
  createSession,
  createUser,
  createWorkspace,
} from '../helpers/factories.js';
import { MemoryObjectStore } from '../helpers/object-store.js';

/**
 * Share links of kanban, calendar, gallery, timeline and list views: each answers only the
 * fields its layout shows and the records its filter keeps. Hidden fields' values, filtered-out
 * records (their names, values, files and ids, also through self links) never leave.
 */
describe('share links of every layout', () => {
  const t = useTestDb();
  const files = new MemoryObjectStore();
  let app: ReturnType<typeof testApp>['app'];
  let appUrl: string;
  let workspaceId: string;
  let cookie: string;

  const send = (method: string, path: string, body?: unknown) => {
    const headers = new Headers({ origin: appUrl, cookie: `${SESSION_COOKIE}=${cookie}` });
    if (body !== undefined) headers.set('content-type', 'application/json');
    return app.request(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  };
  /** A signed-out visitor. */
  const visit = (path: string) => app.request(path, { headers: { origin: appUrl } });

  async function ok<T>(res: Response, status = 200): Promise<T> {
    if (res.status !== status) throw new Error(`${res.status}: ${await res.text()}`);
    return (status === 204 ? undefined : await res.json()) as T;
  }

  beforeAll(async () => {
    const built = testApp({
      db: t.appDb,
      objectStore: files,
      env: { SHARE_RATE_LIMIT: '100000' },
    });
    app = built.app;
    appUrl = built.config.appUrl;
    const tenant = await createWorkspace(t.db, { owner: await createUser(t.db) });
    workspaceId = tenant.workspace.id;
    cookie = await createSession(t.db, tenant.owner);
  });

  /**
   * Tasks: Name, Notes, Status, Secret, Start, End, Cover, Private files, Depends on and Parent
   * (links to Tasks). Alpha and Beta are Done; "Hidden record" is Todo, which every view filters
   * out. Alpha depends on Beta and on the hidden record, and its parent is the hidden record;
   * Beta's parent is Alpha.
   */
  async function fixture() {
    const base = await ok<{ id: string }>(
      await send('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Base' }),
      201
    );
    const table = await ok<TableMeta>(
      await send('POST', `/api/bases/${base.id}/tables`, { name: 'Tasks' }),
      201
    );
    const field = async (body: unknown) =>
      ok<FieldMeta>(await send('POST', `/api/tables/${table.id}/fields`, body), 201);
    const { fields } = await ok<{ fields: FieldMeta[] }>(
      await send('GET', `/api/tables/${table.id}`)
    );
    const byName = (n: string) => {
      const found = fields.find((x) => x.name === n);
      if (!found) throw new Error(`no ${n}`);
      return found;
    };
    const f = {
      table,
      name: byName('Name'),
      notes: byName('Notes'),
      status: byName('Status'),
      secret: await field({ name: 'Secret', type: 'singleLineText' }),
      start: await field({ name: 'Start', type: 'date' }),
      end: await field({ name: 'End', type: 'date' }),
      cover: await field({ name: 'Cover', type: 'attachment' }),
      privateFiles: await field({ name: 'Private files', type: 'attachment' }),
      dependsOn: await field({
        name: 'Depends on',
        type: 'link',
        options: { linkedTableId: table.id },
      }),
      parent: await field({ name: 'Parent', type: 'link', options: { linkedTableId: table.id } }),
    };
    const choices = (f.status.options as { choices: { id: string; name: string }[] }).choices;
    const done = choices.find((c) => c.name === 'Done')?.id;
    const todo = choices.find((c) => c.name === 'Todo')?.id;
    const at = { workspaceId, baseId: base.id, tableId: table.id };
    const file = (fieldId: string, filename: string) =>
      createReadyAttachment(t.db, { ...at, fieldId }, { filename, type: 'image/png', size: 3 });
    const shownCover = await file(f.cover.id, 'shown-cover.png');
    const privateFile = await file(f.privateFiles.id, 'private.png');
    const filteredCover = await file(f.cover.id, 'filtered-cover.png');
    const { records } = await ok<{ records: { id: string }[] }>(
      await send('POST', `/api/tables/${table.id}/records`, {
        records: [
          {
            fields: {
              [f.name.id]: 'Alpha',
              [f.notes.id]: 'Alpha notes',
              [f.status.id]: done,
              [f.secret.id]: 'TOP-SECRET-VALUE',
              [f.start.id]: '2026-03-02',
              [f.end.id]: '2026-03-04',
              [f.cover.id]: [shownCover],
              [f.privateFiles.id]: [privateFile],
            },
          },
          {
            fields: {
              [f.name.id]: 'Beta',
              [f.status.id]: done,
              [f.start.id]: '2026-03-10',
            },
          },
          {
            fields: {
              [f.name.id]: 'Hidden record',
              [f.notes.id]: 'FILTERED-NOTES',
              [f.status.id]: todo,
              [f.secret.id]: 'ALSO-SECRET',
              [f.start.id]: '2026-03-03',
              [f.cover.id]: [filteredCover],
            },
          },
        ],
      }),
      201
    );
    const [alpha, beta, hidden] = records.map((r) => r.id);
    if (!alpha || !beta || !hidden) throw new Error('records not created');
    await ok(
      await send('PATCH', `/api/tables/${table.id}/records`, {
        records: [
          { id: alpha, fields: { [f.dependsOn.id]: [beta, hidden], [f.parent.id]: [hidden] } },
          { id: beta, fields: { [f.parent.id]: [alpha] } },
        ],
      })
    );
    return { ...f, base, done, alpha, beta, hidden, shownCover, privateFile, filteredCover };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  /** A view of the type with the layout, filtered to Status = Done, and a link to it. */
  let made = 0;
  async function sharedView(f: Fixture, type: string, layout: Record<string, unknown>) {
    made += 1;
    const view = await ok<ViewMeta>(
      await send('POST', `/api/tables/${f.table.id}/views`, { name: `${type} ${made}`, type }),
      201
    );
    await ok(
      await send('PATCH', `/api/views/${view.id}`, {
        ...layout,
        query: {
          filter: {
            conjunction: 'and',
            conditions: [{ fieldId: f.status.id, operator: 'is', value: f.done }],
          },
        },
      })
    );
    const { token } = await ok<CreatedShare>(
      await send('POST', `/api/views/${view.id}/shares`, {}),
      201
    );
    const base = `/api/shared/${token}/views/${view.id}`;
    const shown = await ok<SharedView>(await visit(base));
    const page = await ok<{ records: SharedRecord[]; total: number }>(
      await visit(`${base}/records?limit=200`)
    );
    return { view, token, base, shown, page };
  }

  /** Nothing of the hidden fields or the filtered-out record in any answer. */
  function expectNothingHidden(f: Fixture, ...answers: unknown[]) {
    const text = JSON.stringify(answers);
    for (const leak of [
      'TOP-SECRET-VALUE',
      'ALSO-SECRET',
      'Hidden record',
      'FILTERED-NOTES',
      'private.png',
      'filtered-cover.png',
      f.hidden,
      f.secret.id,
      f.privateFiles.id,
      f.privateFile.id,
      f.filteredCover.id,
      f.table.id,
    ]) {
      expect(text, leak).not.toContain(leak);
    }
  }

  const names = (fields: { name: string }[]) => fields.map((x) => x.name);

  it('kanban: the title, stack, cover and card fields; files only of shown covers', async () => {
    const f = await fixture();
    const { base, shown, page } = await sharedView(f, 'kanban', {
      kanban: { stackFieldId: f.status.id, cardFields: [f.notes.id], coverFieldId: f.cover.id },
    });
    expect(shown.view.type).toBe('kanban');
    expect(names(shown.fields).sort()).toEqual(['Cover', 'Name', 'Notes', 'Status']);
    expect(shown.kanban).toEqual({
      stackFieldId: f.status.id,
      cardFields: [f.notes.id],
      coverFieldId: f.cover.id,
    });
    expect(page.total).toBe(2);
    expect(page.records.map((r) => r.fields[f.name.id]).sort()).toEqual(['Alpha', 'Beta']);
    expectNothingHidden(f, shown, page);
    // The cover of a shown card downloads (a signed URL); hidden and filtered files are 404.
    expect((await visit(`${base}/attachments/${f.shownCover.id}`)).status).toBe(302);
    for (const id of [f.privateFile.id, f.filteredCover.id]) {
      expect((await visit(`${base}/attachments/${id}/thumbnail`)).status).toBe(404);
      expect((await visit(`${base}/attachments/${id}`)).status).toBe(404);
    }
    // Only calendars and timelines take a date window.
    expect((await visit(`${base}/records?from=2026-03-01&to=2026-03-31`)).status).toBe(422);
  });

  it('gallery: its card fields (else the first three) and cover', async () => {
    const f = await fixture();
    const { shown, page } = await sharedView(f, 'gallery', {
      gallery: { cardFields: [f.status.id], coverFieldId: f.cover.id, cardSize: 'large' },
    });
    expect(names(shown.fields).sort()).toEqual(['Cover', 'Name', 'Status']);
    expect(shown.gallery).toMatchObject({ cardFields: [f.status.id], cardSize: 'large' });
    expect(page.total).toBe(2);
    expectNothingHidden(f, shown, page);

    // No saved card fields: the first three after the title, as the app shows them.
    const defaults = await sharedView(f, 'gallery', { gallery: {} });
    expect(names(defaults.shown.fields)).toEqual(['Name', 'Notes', 'Status', 'Secret']);
    expect(defaults.shown.gallery?.cardFields).toEqual([f.notes.id, f.status.id, f.secret.id]);
  });

  it('calendar: the title, dates and colour field; a date window narrows it', async () => {
    const f = await fixture();
    const { base, shown, page } = await sharedView(f, 'calendar', {
      calendar: {
        dateFields: [{ startFieldId: f.start.id, endFieldId: f.end.id }],
        colorFieldId: f.status.id,
      },
    });
    expect(names(shown.fields).sort()).toEqual(['End', 'Name', 'Start', 'Status']);
    expect(page.total).toBe(2);
    expectNothingHidden(f, shown, page);
    // The first week of March: Alpha only (the hidden record falls in it too, but is filtered).
    const week = await ok<{ records: SharedRecord[]; total: number }>(
      await visit(`${base}/records?from=2026-03-01&to=2026-03-07`)
    );
    expect(week.records.map((r) => r.id)).toEqual([f.alpha]);
    expectNothingHidden(f, week);
    for (const query of [
      'from=2026-03-01',
      'from=2026-03-07&to=2026-03-01',
      'from=2026-01-01&to=2027-06-01',
      'from=March&to=April',
      'from=2026-03-01&to=2026-03-07&filter=x',
    ]) {
      expect((await visit(`${base}/records?${query}`)).status, query).toBe(422);
    }
  });

  it('timeline: dependencies as ids of shown records only', async () => {
    const f = await fixture();
    const { base, shown, page } = await sharedView(f, 'timeline', {
      timeline: {
        startFieldId: f.start.id,
        endFieldId: f.end.id,
        groupFieldId: f.status.id,
        dependencyFieldId: f.dependsOn.id,
      },
    });
    expect(names(shown.fields).sort()).toEqual(['End', 'Name', 'Start', 'Status']);
    expect(shown.timeline).toMatchObject({ dependencyFieldId: f.dependsOn.id });
    const alpha = page.records.find((r) => r.id === f.alpha);
    expect(alpha?.links).toEqual({ [f.dependsOn.id]: [f.beta] });
    expect(alpha?.fields[f.dependsOn.id]).toBeUndefined();
    expectNothingHidden(f, shown, page);
    // Also through a window that leaves Beta out: the link still names only shown records.
    const week = await ok<{ records: SharedRecord[] }>(
      await visit(`${base}/records?from=2026-03-01&to=2026-03-07`)
    );
    expect(week.records.map((r) => [r.id, r.links])).toEqual([
      [f.alpha, { [f.dependsOn.id]: [f.beta] }],
    ]);
    expectNothingHidden(f, week);
  });

  it('list: parents as ids of shown records only, and its row fields', async () => {
    const f = await fixture();
    const { shown, page } = await sharedView(f, 'list', {
      list: { parentFieldId: f.parent.id, rowFields: [f.notes.id] },
    });
    expect(names(shown.fields).sort()).toEqual(['Name', 'Notes']);
    expect(shown.list).toEqual({ parentFieldId: f.parent.id, rowFields: [f.notes.id] });
    const links = Object.fromEntries(page.records.map((r) => [r.id, r.links]));
    expect(links).toEqual({
      [f.alpha]: { [f.parent.id]: [] },
      [f.beta]: { [f.parent.id]: [f.alpha] },
    });
    expectNothingHidden(f, shown, page);
  });

  it('base links list every layout and serve each with its projection', async () => {
    const f = await fixture();
    const calendar = await sharedView(f, 'calendar', {
      calendar: { dateFields: [{ startFieldId: f.start.id }] },
    });
    const { token } = await ok<CreatedShare>(
      await send('POST', `/api/bases/${f.base.id}/shares`, {}),
      201
    );
    const summary = await ok<{ tables: { views: { id: string; type: string }[] }[] }>(
      await visit(`/api/shared/${token}`)
    );
    const types = summary.tables.flatMap((x) => x.views.map((v) => v.type));
    expect(types).toContain('calendar');
    const viewBase = `/api/shared/${token}/views/${calendar.view.id}`;
    const shown = await ok<SharedView>(await visit(viewBase));
    expect(names(shown.fields).sort()).toEqual(['Name', 'Start']);
    const page = await ok<{ records: SharedRecord[] }>(await visit(`${viewBase}/records`));
    expect(page.records).toHaveLength(2);
    expectNothingHidden(f, shown, page);
  });
});

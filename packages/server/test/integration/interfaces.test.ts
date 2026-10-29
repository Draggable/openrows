import type {
  Base,
  FieldMeta,
  Interface,
  InterfaceList,
  InterfacePage,
  InterfacePageConfig,
  TableMeta,
} from '@openrows/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createWorkspace } from '../helpers/factories.js';

/**
 * Interfaces: creators build pages (drafts checked against the base) and publish them;
 * everyone else on the base sees published pages only, and their published copy: a page never
 * published is invisible (missing from the list, 404 by id), and later draft changes stay
 * unseen until the next publish.
 */
describe('interfaces', () => {
  const t = useTestDb();
  let app: ReturnType<typeof testApp>['app'];
  let owner: string;
  let editor: string;
  let viewer: string;
  let base: Base;
  let table: TableMeta;
  let status: FieldMeta;
  let otherTable: TableMeta;

  const json = (method: string, path: string, body?: unknown, as = owner) =>
    app.request(path, {
      method,
      headers: {
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
        cookie: `${SESSION_COOKIE}=${as}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  async function ok<T>(res: Response | Promise<Response>, expected = 200): Promise<T> {
    const r = await res;
    if (r.status !== expected) throw new Error(`${r.status}: ${await r.text()}`);
    return (expected === 204 ? null : await r.json()) as T;
  }

  beforeAll(async () => {
    ({ app } = testApp({ db: t.appDb }));
    const ws = await createWorkspace(t.db);
    owner = await createSession(t.db, ws.owner);
    editor = await createSession(t.db, await addMember(t.db, ws.workspace.id, 'editor'));
    viewer = await createSession(t.db, await addMember(t.db, ws.workspace.id, 'read_only'));
    base = await ok<Base>(
      json('POST', `/api/workspaces/${ws.workspace.id}/bases`, { name: 'Ops' }),
      201
    );
    table = await ok<TableMeta>(
      json('POST', `/api/bases/${base.id}/tables`, { name: 'Tasks' }),
      201
    );
    status = await ok<FieldMeta>(
      json('POST', `/api/tables/${table.id}/fields`, {
        name: 'Stage',
        type: 'singleSelect',
        options: {
          choices: [
            { id: 'open', name: 'Open', color: 'green' },
            { id: 'done', name: 'Done', color: 'blue' },
          ],
        },
      }),
      201
    );
    otherTable = await ok<TableMeta>(
      json('POST', `/api/bases/${base.id}/tables`, { name: 'Other' }),
      201
    );
  });

  const list = (as: string) =>
    ok<InterfaceList>(json('GET', `/api/bases/${base.id}/interfaces`, undefined, as));
  const pagePath = (i: Interface, p: InterfacePage) =>
    `/api/bases/${base.id}/interfaces/${i.id}/pages/${p.id}`;
  async function newPage(name = 'Review') {
    const iface = await ok<Interface>(
      json('POST', `/api/bases/${base.id}/interfaces`, { name: `${name} app` }),
      201
    );
    const page = await ok<InterfacePage>(
      json('POST', `/api/bases/${base.id}/interfaces/${iface.id}/pages`, {
        name,
        layout: 'recordReview',
        tableId: table.id,
      }),
      201
    );
    return { iface, page };
  }
  const reviewDraft = (extra: Partial<InterfacePageConfig> = {}): InterfacePageConfig => ({
    layout: 'recordReview',
    tableId: table.id,
    sorts: [],
    fields: [status.id],
    filter: { conjunction: 'and', conditions: [{ fieldId: status.id, operator: 'isNotEmpty' }] },
    elements: [
      { id: 'title', type: 'text', x: 0, y: 0, w: 12, h: 2, content: '# Review' },
      { id: 'status', type: 'filter', x: 0, y: 2, w: 4, h: 2, fieldId: status.id, label: '' },
      { id: 'detail', type: 'field', x: 0, y: 4, w: 6, h: 2, fieldId: status.id, editable: true },
      {
        id: 'docs',
        type: 'button',
        x: 6,
        y: 4,
        w: 3,
        h: 1,
        label: 'Docs',
        action: { type: 'openUrl', url: 'https://openrows.io/docs' },
      },
    ],
    ...extra,
  });

  it('keeps an unpublished page invisible to everyone below creator', async () => {
    const { iface, page } = await newPage('Hidden');
    expect(page).toMatchObject({ published: null, publishedAt: null, hasChanges: true });
    expect(page.draft).toMatchObject({ layout: 'recordReview', tableId: table.id, elements: [] });

    const asOwner = await list(owner);
    expect(asOwner.canEdit).toBe(true);
    expect(asOwner.interfaces.find((i) => i.id === iface.id)?.pages.map((p) => p.id)).toEqual([
      page.id,
    ]);
    for (const as of [editor, viewer]) {
      const seen = await list(as);
      expect(seen.canEdit).toBe(false);
      expect(seen.interfaces.find((i) => i.id === iface.id)).toBeUndefined();
      expect((await json('GET', pagePath(iface, page), undefined, as)).status).toBe(404);
    }
    // Below creator, nothing is built or published.
    expect((await json('POST', `${pagePath(iface, page)}/publish`, undefined, editor)).status).toBe(
      403
    );
    expect(
      (await json('PATCH', pagePath(iface, page), { draft: reviewDraft() }, editor)).status
    ).toBe(403);
  });

  it('builds, publishes and republishes a record review page', async () => {
    const { iface, page } = await newPage('Review');
    const saved = await ok<InterfacePage>(
      json('PATCH', pagePath(iface, page), { draft: reviewDraft() })
    );
    expect(saved.draft?.elements).toHaveLength(4);
    expect(saved.hasChanges).toBe(true);

    const published = await ok<InterfacePage>(json('POST', `${pagePath(iface, page)}/publish`));
    expect(published.hasChanges).toBe(false);
    expect(published.publishedAt).not.toBeNull();
    expect(published.published).toEqual(saved.draft);

    const seen = await ok<InterfacePage>(json('GET', pagePath(iface, page), undefined, viewer));
    expect(seen.draft).toBeNull();
    expect(seen.published?.elements.map((e) => e.id)).toEqual([
      'title',
      'status',
      'detail',
      'docs',
    ]);
    const listed = (await list(viewer)).interfaces.find((i) => i.id === iface.id);
    expect(listed?.pages.map((p) => p.id)).toEqual([page.id]);

    // A later draft stays unseen until it is published.
    await ok(json('PATCH', pagePath(iface, page), { draft: reviewDraft({ elements: [] }) }));
    const after = await ok<InterfacePage>(json('GET', pagePath(iface, page), undefined, viewer));
    expect(after.published?.elements).toHaveLength(4);
    expect((await ok<InterfacePage>(json('GET', pagePath(iface, page)))).hasChanges).toBe(true);

    // Unpublished again: gone for viewers.
    await ok(json('POST', `${pagePath(iface, page)}/unpublish`));
    expect((await json('GET', pagePath(iface, page), undefined, viewer)).status).toBe(404);
  });

  it('checks drafts against the base', async () => {
    const { iface, page } = await newPage('Checked');
    const refused = async (draft: unknown, path: string) => {
      const res = await json('PATCH', pagePath(iface, page), { draft });
      expect(res.status).toBe(422);
      const problem = (await res.json()) as { errors?: { path: string }[] };
      expect(problem.errors?.map((e) => e.path)).toContain(path);
    };
    // A field of another table, a table of another base (any unknown id), a filter on the
    // primary text field is fine, but a record element on a record list is not.
    await refused(reviewDraft({ fields: [otherTable.fields[0]?.id ?? ''] }), 'draft.fields.0');
    await refused(
      reviewDraft({ tableId: '01900000-0000-7000-8000-000000000000' }),
      'draft.tableId'
    );
    await refused(reviewDraft({ layout: 'recordList' }), 'draft.elements.2.type');
    await refused(
      reviewDraft({
        elements: [
          {
            id: 'b',
            type: 'button',
            x: 0,
            y: 0,
            w: 2,
            h: 1,
            label: 'Run',
            action: { type: 'runAutomation', fieldId: status.id },
          },
        ],
      }),
      'draft.elements.0.action.fieldId'
    );
    await refused(
      reviewDraft({
        elements: [
          {
            id: 'x',
            type: 'button',
            x: 0,
            y: 0,
            w: 2,
            h: 1,
            label: 'Bad',
            action: { type: 'openUrl', url: 'javascript:alert(1)' },
          },
        ],
      }),
      'draft.elements.0.action.url'
    );
    await refused(
      reviewDraft({
        elements: [{ id: 'w', type: 'text', x: 8, y: 0, w: 6, h: 1, content: '' }],
      }),
      'draft.elements.0.w'
    );
    await refused(
      reviewDraft({
        filter: {
          conjunction: 'and',
          conditions: [{ fieldId: status.id, operator: 'isWithin', value: 'pastWeek' }],
        },
      }),
      'draft.filter.conditions.0'
    );
  });

  it('keeps ids of other bases out', async () => {
    const ws = await createWorkspace(t.db);
    const stranger = await createSession(t.db, ws.owner);
    const { iface, page } = await newPage('Mine');
    expect((await json('GET', pagePath(iface, page), undefined, stranger)).status).toBe(404);
    const otherBase = await ok<Base>(
      json('POST', `/api/workspaces/${ws.workspace.id}/bases`, { name: 'Theirs' }, stranger),
      201
    );
    // Their base, my interface's id: not in their base.
    expect(
      (
        await json(
          'GET',
          `/api/bases/${otherBase.id}/interfaces/${iface.id}/pages/${page.id}`,
          undefined,
          stranger
        )
      ).status
    ).toBe(404);
    // And they can't build a page over my table.
    const theirs = await ok<Interface>(
      json('POST', `/api/bases/${otherBase.id}/interfaces`, { name: 'X' }, stranger),
      201
    );
    const res = await json(
      'POST',
      `/api/bases/${otherBase.id}/interfaces/${theirs.id}/pages`,
      { name: 'Steal', layout: 'recordList', tableId: table.id },
      stranger
    );
    expect(res.status).toBe(422);
  });

  it('deletes an interface with its pages', async () => {
    const { iface, page } = await newPage('Gone');
    await ok(json('DELETE', `/api/bases/${base.id}/interfaces/${iface.id}`), 204);
    expect((await json('GET', pagePath(iface, page))).status).toBe(404);
  });
});

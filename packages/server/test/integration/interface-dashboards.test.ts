import type {
  Base,
  FieldMeta,
  FilterGroup,
  Interface,
  InterfaceElement,
  InterfacePage,
  InterfacePageConfig,
  InterfacePageData,
  QueryRecordsResult,
  TableMeta,
  ViewMeta as View,
} from '@openrows/shared';
import { MAX_CHART_GROUPS, MAX_CHART_SERIES } from '@openrows/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import type { FieldVisibility } from '../../src/realtime/projection.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createWorkspace } from '../helpers/factories.js';

/**
 * Dashboards: number and chart elements are computed on the server through the ViewQuery
 * compiler. Their values must match what `POST /api/tables/:tableId/records/query` answers for
 * the same records (aggregates, group counts), with the element's filter, the page's filter and
 * the viewer's filter elements applied, a view's filter when the element reads a view, and
 * fields the viewer can't read refused.
 */
describe('interface dashboards', () => {
  const t = useTestDb();
  let app: ReturnType<typeof testApp>['app'];
  let owner: string;
  let editor: string;
  let viewer: string;
  let viewerId: string;
  let base: Base;
  let deals: TableMeta;
  let other: TableMeta;
  let name: FieldMeta;
  let stage: FieldMeta;
  let region: FieldMeta;
  let amount: FieldMeta;
  let closed: FieldMeta;

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
    return (await r.json()) as T;
  }
  const field = (tableId: string, body: unknown) =>
    ok<FieldMeta>(json('POST', `/api/tables/${tableId}/fields`, body), 201);

  const STAGES = ['lead', 'won', 'lost'] as const;
  const REGIONS = ['eu', 'us'] as const;

  // Hidden fields per viewer, set by the test that needs them.
  let hiddenForViewer = new Set<string>();
  const visibility: FieldVisibility = {
    hiddenFields: (v) => (v.userId === viewerId ? hiddenForViewer : new Set()),
  };

  beforeAll(async () => {
    ({ app } = testApp({ db: t.appDb, visibility }));
    const ws = await createWorkspace(t.db);
    owner = await createSession(t.db, ws.owner);
    editor = await createSession(t.db, await addMember(t.db, ws.workspace.id, 'editor'));
    const reader = await addMember(t.db, ws.workspace.id, 'read_only');
    viewerId = reader.id;
    viewer = await createSession(t.db, reader);
    base = await ok<Base>(
      json('POST', `/api/workspaces/${ws.workspace.id}/bases`, { name: 'Sales' }),
      201
    );
    deals = await ok<TableMeta>(
      json('POST', `/api/bases/${base.id}/tables`, { name: 'Deals' }),
      201
    );
    other = await ok<TableMeta>(
      json('POST', `/api/bases/${base.id}/tables`, { name: 'Notes' }),
      201
    );
    const fresh = await ok<TableMeta>(json('GET', `/api/tables/${deals.id}`));
    name = fresh.fields.find((f) => f.isPrimary) as FieldMeta;
    stage = await field(deals.id, {
      name: 'Stage',
      type: 'singleSelect',
      options: { choices: STAGES.map((id) => ({ id, name: id.toUpperCase(), color: 'green' })) },
    });
    region = await field(deals.id, {
      name: 'Region',
      type: 'singleSelect',
      options: { choices: REGIONS.map((id) => ({ id, name: id.toUpperCase(), color: 'blue' })) },
    });
    amount = await field(deals.id, { name: 'Amount', type: 'number', options: { precision: 2 } });
    closed = await field(deals.id, { name: 'Closed', type: 'date' });
    // 60 deals: every stage and region, some amounts and stages empty.
    const records = Array.from({ length: 60 }, (_, i) => ({
      fields: {
        [name.id]: `Deal ${i}`,
        [stage.id]: i % 10 === 9 ? null : STAGES[i % 3],
        [region.id]: REGIONS[i % 2],
        [amount.id]: i % 7 === 0 ? null : ((i * 37) % 500) + 0.25,
        [closed.id]: `2026-0${(i % 9) + 1}-1${i % 10}`,
      },
    }));
    await ok(json('POST', `/api/tables/${deals.id}/records`, { records }), 201);
  });

  const at = { x: 0, y: 0, w: 4, h: 3 };
  async function publishedPage(
    config: Omit<Partial<InterfacePageConfig>, 'elements'> & { elements: unknown[] }
  ) {
    const iface = await ok<Interface>(
      json('POST', `/api/bases/${base.id}/interfaces`, { name: 'Dash' }),
      201
    );
    const page = await ok<InterfacePage>(
      json('POST', `/api/bases/${base.id}/interfaces/${iface.id}/pages`, {
        name: 'Overview',
        layout: 'dashboard',
        tableId: deals.id,
      }),
      201
    );
    const path = `/api/bases/${base.id}/interfaces/${iface.id}/pages/${page.id}`;
    // The data route is the interface's own.
    const dataPath = `/api/interfaces/${iface.id}/pages/${page.id}/data`;
    await ok(
      json('PATCH', path, {
        draft: { layout: 'dashboard', tableId: deals.id, ...config },
      })
    );
    await ok(json('POST', `${path}/publish`));
    const data = (body: unknown = {}, as = owner) =>
      ok<InterfacePageData>(json('POST', dataPath, body, as));
    return { iface, page, path, dataPath, data };
  }

  const query = (body: unknown) =>
    ok<QueryRecordsResult>(json('POST', `/api/tables/${deals.id}/records/query`, body));
  const numberOf = (data: InterfacePageData, id: string) => {
    const el = data.elements[id];
    if (el?.type !== 'number') throw new Error(`not a number: ${JSON.stringify(el)}`);
    return el;
  };
  const chartOf = (data: InterfacePageData, id: string) => {
    const el = data.elements[id];
    if (el?.type !== 'chart') throw new Error(`not a chart: ${JSON.stringify(el)}`);
    return el;
  };

  it('answers numbers equal to the ViewQuery aggregates, with the element filter', async () => {
    const won: FilterGroup = {
      conjunction: 'and',
      conditions: [{ fieldId: stage.id, operator: 'is', value: 'won' }],
    };
    const fns = ['sum', 'avg', 'min', 'max', 'filled', 'empty', 'unique'] as const;
    const elements = [
      { ...at, id: 'all', type: 'number', tableId: deals.id },
      { ...at, id: 'won', type: 'number', tableId: deals.id, filter: won },
      ...fns.map((fn) => ({
        ...at,
        id: fn,
        type: 'number',
        tableId: deals.id,
        fieldId: amount.id,
        fn,
      })),
      { ...at, id: 'last', type: 'number', tableId: deals.id, fieldId: closed.id, fn: 'max' },
      {
        ...at,
        id: 'wonSum',
        type: 'number',
        tableId: deals.id,
        filter: won,
        fieldId: amount.id,
        fn: 'sum',
      },
    ];
    const { data } = await publishedPage({ elements });
    const got = await data();

    const everything = await query({
      limit: 0,
      aggregates: [
        ...fns.map((fn) => ({ fieldId: amount.id, fn })),
        { fieldId: closed.id, fn: 'max' },
      ],
    });
    expect(numberOf(got, 'all')).toEqual({ type: 'number', value: 60, records: 60 });
    for (const fn of fns) {
      expect(numberOf(got, fn).value).toEqual(everything.aggregates?.[amount.id]?.[fn]);
    }
    expect(numberOf(got, 'last').value).toEqual(everything.aggregates?.[closed.id]?.['max']);
    const onlyWon = await query({
      query: { filter: won },
      limit: 0,
      aggregates: [{ fieldId: amount.id, fn: 'sum' }],
    });
    expect(numberOf(got, 'won')).toMatchObject({ value: onlyWon.total, records: onlyWon.total });
    expect(numberOf(got, 'wonSum').value).toEqual(onlyWon.aggregates?.[amount.id]?.['sum']);
    // The fixture really filters.
    expect(onlyWon.total).toBeGreaterThan(5);
    expect(onlyWon.total).toBeLessThan(60);
  });

  it('applies the page filter and the viewer filter elements to elements on the page table only', async () => {
    const eu: FilterGroup = {
      conjunction: 'and',
      conditions: [{ fieldId: region.id, operator: 'is', value: 'eu' }],
    };
    const { data } = await publishedPage({
      filter: eu,
      elements: [
        { ...at, id: 'stageFilter', type: 'filter', fieldId: stage.id, label: '' },
        { ...at, id: 'deals', type: 'number', tableId: deals.id, fieldId: amount.id, fn: 'sum' },
        { ...at, id: 'notes', type: 'number', tableId: other.id },
      ],
    });
    const plain = await data();
    const euOnly = await query({
      query: { filter: eu },
      limit: 0,
      aggregates: [{ fieldId: amount.id, fn: 'sum' }],
    });
    expect(numberOf(plain, 'deals')).toMatchObject({
      value: euOnly.aggregates?.[amount.id]?.['sum'],
      records: euOnly.total,
    });
    expect(numberOf(plain, 'notes').records).toBe(0);

    const filtered = await data({ filters: { stageFilter: 'lost' } }, viewer);
    const euLost = await query({
      query: { filter: eu, within: [{ fieldId: stage.id, operator: 'is', value: 'lost' }] },
      limit: 0,
      aggregates: [{ fieldId: amount.id, fn: 'sum' }],
    });
    expect(numberOf(filtered, 'deals')).toMatchObject({
      value: euLost.aggregates?.[amount.id]?.['sum'],
      records: euLost.total,
    });
    expect(euLost.total).toBeLessThan(euOnly.total ?? 0);
  });

  it("reads a view's filter, and refuses personal views", async () => {
    const view = await ok<View>(
      json('POST', `/api/tables/${deals.id}/views`, { name: 'Lost', type: 'grid' }),
      201
    );
    const lost: FilterGroup = {
      conjunction: 'and',
      conditions: [{ fieldId: stage.id, operator: 'is', value: 'lost' }],
    };
    await ok(
      json('PATCH', `/api/views/${view.id}`, {
        query: { filter: lost, sorts: [{ fieldId: amount.id, direction: 'desc' }] },
      })
    );
    const { data } = await publishedPage({
      elements: [
        {
          ...at,
          id: 'lost',
          type: 'number',
          tableId: deals.id,
          viewId: view.id,
          fieldId: amount.id,
          fn: 'avg',
        },
        {
          ...at,
          id: 'lostEu',
          type: 'chart',
          chart: 'bar',
          tableId: deals.id,
          viewId: view.id,
          filter: {
            conjunction: 'and',
            conditions: [{ fieldId: region.id, operator: 'is', value: 'eu' }],
          },
          groupFieldId: region.id,
        },
      ],
    });
    const got = await data({}, viewer);
    const viaView = await query({
      viewId: view.id,
      limit: 0,
      aggregates: [{ fieldId: amount.id, fn: 'avg' }],
    });
    expect(numberOf(got, 'lost')).toMatchObject({
      value: viaView.aggregates?.[amount.id]?.['avg'],
      records: viaView.total,
    });
    const lostEu = await query({
      viewId: view.id,
      query: { within: [{ fieldId: region.id, operator: 'is', value: 'eu' }] },
      limit: 0,
    });
    expect(chartOf(got, 'lostEu')).toMatchObject({
      series: null,
      rows: [{ key: 'eu', values: [lostEu.total] }],
      records: lostEu.total,
    });

    const mine = await ok<View>(
      json('POST', `/api/tables/${deals.id}/views`, { name: 'Mine', type: 'grid', personal: true }),
      201
    );
    const { path } = await publishedPage({ elements: [] });
    const res = await json('PATCH', path, {
      draft: {
        layout: 'dashboard',
        tableId: deals.id,
        elements: [{ ...at, id: 'n', type: 'number', tableId: deals.id, viewId: mine.id }],
      },
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('draft.elements.0.viewId');
  });

  it('charts group counts and sums as the ViewQuery groups them', async () => {
    const { data } = await publishedPage({
      elements: [
        {
          ...at,
          id: 'byStage',
          type: 'chart',
          chart: 'bar',
          tableId: deals.id,
          groupFieldId: stage.id,
        },
        {
          ...at,
          id: 'sumByStage',
          type: 'chart',
          chart: 'line',
          tableId: deals.id,
          groupFieldId: stage.id,
          fieldId: amount.id,
          fn: 'sum',
          order: 'valueDesc',
        },
        {
          ...at,
          id: 'stacked',
          type: 'chart',
          chart: 'stackedBar',
          tableId: deals.id,
          groupFieldId: stage.id,
          seriesFieldId: region.id,
        },
      ],
    });
    const got = await data({}, editor);

    const groups = await query({
      query: { groupBy: [{ fieldId: stage.id }] },
      limit: 0,
      groups: true,
    });
    const byStage = chartOf(got, 'byStage');
    expect(byStage.rows.map((r) => [r.key, r.values[0]])).toEqual(
      groups.groups?.map((g) => [g.key[0], g.count])
    );
    expect(byStage.rows).toHaveLength(4);

    // Sums per stage, from each stage's own aggregate query.
    const sums = await Promise.all(
      [...STAGES, null].map(async (s) => {
        const r = await query({
          query: {
            filter: {
              conjunction: 'and',
              conditions: [
                s === null
                  ? { fieldId: stage.id, operator: 'isEmpty' }
                  : { fieldId: stage.id, operator: 'is', value: s },
              ],
            },
          },
          limit: 0,
          aggregates: [{ fieldId: amount.id, fn: 'sum' }],
        });
        return [s, r.aggregates?.[amount.id]?.['sum'] as number | null] as const;
      })
    );
    const expected = [...sums].sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
    expect(chartOf(got, 'sumByStage').rows.map((r) => [r.key, r.values[0]])).toEqual(expected);

    const pairs = await query({
      query: { groupBy: [{ fieldId: stage.id }, { fieldId: region.id }] },
      limit: 0,
      groups: true,
    });
    const stacked = chartOf(got, 'stacked');
    expect(stacked.series).toEqual(['eu', 'us']);
    for (const g of pairs.groups ?? []) {
      const row = stacked.rows.find((r) => r.key === g.key[0]);
      expect(row?.values[(stacked.series ?? []).indexOf(g.key[1])]).toBe(g.count);
    }
    expect(stacked.records).toBe(60);
  });

  it('caps groups: a pie folds the rest into Other, bars are truncated', async () => {
    const { data } = await publishedPage({
      elements: [
        {
          ...at,
          id: 'pie',
          type: 'chart',
          chart: 'pie',
          tableId: deals.id,
          groupFieldId: name.id,
          order: 'valueDesc',
        },
        {
          ...at,
          id: 'bars',
          type: 'chart',
          chart: 'bar',
          tableId: deals.id,
          groupFieldId: name.id,
        },
      ],
    });
    const got = await data();
    const pie = chartOf(got, 'pie');
    const cap = MAX_CHART_SERIES;
    expect(pie.rows).toHaveLength(cap);
    expect(pie.rows.at(-1)).toEqual({ key: null, values: [60 - (cap - 1)], other: true });
    const bars = chartOf(got, 'bars');
    expect(bars.rows).toHaveLength(MAX_CHART_GROUPS);
    expect(bars.truncated).toBe(true);
  });

  it("refuses elements reading fields the viewer can't read, and keeps the others", async () => {
    const { data } = await publishedPage({
      elements: [
        { ...at, id: 'count', type: 'number', tableId: deals.id },
        { ...at, id: 'sum', type: 'number', tableId: deals.id, fieldId: amount.id, fn: 'sum' },
        {
          ...at,
          id: 'filtered',
          type: 'number',
          tableId: deals.id,
          filter: {
            conjunction: 'and',
            conditions: [{ fieldId: amount.id, operator: '>', value: 100 }],
          },
        },
        { ...at, id: 'chart', type: 'chart', tableId: deals.id, groupFieldId: amount.id },
      ],
    });
    hiddenForViewer = new Set([amount.id]);
    try {
      const got = await data({}, viewer);
      expect(numberOf(got, 'count').value).toBe(60);
      for (const id of ['sum', 'filtered', 'chart']) {
        expect(got.elements[id]).toMatchObject({ type: 'error', code: 'hidden' });
      }
      // Others still see every element.
      expect(numberOf(await data({}, editor), 'sum').value).not.toBeNull();
    } finally {
      hiddenForViewer = new Set();
    }
  });

  it('serves drafts to creators only, and published pages to everyone on the base', async () => {
    const { path, dataPath, data } = await publishedPage({
      elements: [{ ...at, id: 'n', type: 'number', tableId: deals.id }],
    });
    await ok(
      json('PATCH', path, {
        draft: {
          layout: 'dashboard',
          tableId: deals.id,
          elements: [{ ...at, id: 'n', type: 'number', tableId: deals.id, filter: wonFilterOf() }],
        },
      })
    );
    expect(numberOf(await data({}, viewer), 'n').value).toBe(60);
    const draft = numberOf(await data({ draft: true }), 'n').value;
    expect(draft).toBeLessThan(60);
    for (const as of [editor, viewer]) {
      expect((await json('POST', dataPath, { draft: true }, as)).status).toBe(404);
    }
    await ok(json('POST', `${path}/unpublish`));
    expect((await json('POST', dataPath, {}, viewer)).status).toBe(404);
    expect((await json('POST', dataPath, {}, owner)).status).toBe(404);
    expect(numberOf(await data({ draft: true }), 'n').value).toBe(draft);
  });

  function wonFilterOf(): FilterGroup {
    return {
      conjunction: 'and',
      conditions: [{ fieldId: stage.id, operator: 'is', value: 'won' }],
    };
  }

  it('checks number and chart settings against the base when saving', async () => {
    const { path } = await publishedPage({ elements: [] });
    const save = (elements: InterfaceElement[] | unknown[]) =>
      json('PATCH', path, { draft: { layout: 'dashboard', tableId: deals.id, elements } });
    const problems = async (elements: unknown[]) => {
      const res = await save(elements);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { errors: { path: string }[] };
      return body.errors.map((e) => e.path);
    };
    expect(
      await problems([
        { ...at, id: 'n', type: 'number', tableId: deals.id, fieldId: stage.id, fn: 'sum' },
      ])
    ).toEqual(['draft.elements.0.fn']);
    expect(
      await problems([
        {
          ...at,
          id: 'c',
          type: 'chart',
          tableId: deals.id,
          groupFieldId: stage.id,
          fieldId: name.id,
          fn: 'sum',
        },
      ])
    ).toEqual(['draft.elements.0.fieldId']);
    expect(
      await problems([
        {
          ...at,
          id: 'c',
          type: 'chart',
          tableId: deals.id,
          groupFieldId: amount.id,
          seriesFieldId: other.id,
        },
      ])
    ).toEqual(['draft.elements.0.seriesFieldId']);
    expect(
      await problems([
        {
          ...at,
          id: 'n',
          type: 'number',
          tableId: deals.id,
          filter: {
            conjunction: 'and',
            conditions: [{ fieldId: stage.id, operator: 'contains', value: 'x' }],
          },
        },
      ])
    ).toEqual([expect.stringMatching(/^draft\.elements\.0\.filter/)]);

    // A table of another base (of another workspace) is "no such table".
    const elsewhere = await createWorkspace(t.db);
    const otherOwner = await createSession(t.db, elsewhere.owner);
    const foreignBase = await ok<Base>(
      json('POST', `/api/workspaces/${elsewhere.workspace.id}/bases`, { name: 'X' }, otherOwner),
      201
    );
    const foreign = await ok<TableMeta>(
      json('POST', `/api/bases/${foreignBase.id}/tables`, { name: 'Secret' }, otherOwner),
      201
    );
    expect(await problems([{ ...at, id: 'n', type: 'number', tableId: foreign.id }])).toEqual([
      'draft.elements.0.tableId',
    ]);
  });

  it('answers an error for an element whose field was deleted since publishing', async () => {
    const extra = await field(deals.id, { name: 'Score', type: 'number' });
    const { data } = await publishedPage({
      elements: [
        { ...at, id: 'ok', type: 'number', tableId: deals.id },
        { ...at, id: 'gone', type: 'number', tableId: deals.id, fieldId: extra.id, fn: 'sum' },
      ],
    });
    expect((await json('DELETE', `/api/fields/${extra.id}`)).status).toBeLessThan(300);
    const got = await data({}, viewer);
    expect(numberOf(got, 'ok').value).toBe(60);
    expect(got.elements['gone']).toMatchObject({ type: 'error', code: 'invalid' });
  });
});

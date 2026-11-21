import type {
  InterfacePageConfig,
  InterfacePageRecords,
  SharedField,
  SharedRecord,
  SharedView,
} from '@openrows/shared';
import { QueryClient, QueryClientProvider, queryOptions } from '@tanstack/react-query';
import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SharedLayout } from '../share/SharedLayouts';
import { addDays, localToday } from '../views/calendar/model';
import { SCALES } from '../views/timeline/model';
import { PageRuntime } from './PageRuntime';

const uuid = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const TABLE_ID = uuid(100);
const SOURCE = {
  baseId: uuid(101),
  interfaceId: uuid(102),
  pageId: uuid(103),
  draft: false,
  interfaceOnly: true,
};

const name: SharedField = {
  id: uuid(1),
  name: 'Name',
  type: 'singleLineText',
  options: {},
  isPrimary: true,
};
const stage: SharedField = {
  id: uuid(2),
  name: 'Stage',
  type: 'singleSelect',
  options: {
    choices: [
      { id: 'open', name: 'Open', color: 'green' },
      { id: 'done', name: 'Done', color: 'blue' },
    ],
  },
  isPrimary: false,
};
const owner: SharedField = {
  id: uuid(3),
  name: 'Owner',
  type: 'user',
  options: {},
  isPrimary: false,
};
const start: SharedField = {
  id: uuid(4),
  name: 'Start',
  type: 'date',
  options: {},
  isPrimary: false,
};
const end: SharedField = { id: uuid(5), name: 'End', type: 'date', options: {}, isPrimary: false };

/**
 * The page's records and record routes, in memory: the records route answers the records (with
 * the editable fields), and an edit through the page applies to them unless it is refused.
 */
function fakePage(opts: {
  fields: SharedField[];
  records: SharedRecord[];
  editable: string[];
  extra?: Partial<InterfacePageRecords>;
  refuse?: boolean;
}) {
  const records = opts.records.map((r) => ({ ...r, fields: { ...r.fields } }));
  const writes: { recordId: string; fields: Record<string, unknown> }[] = [];
  const others: string[] = [];
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const base = `/api/interfaces/${SOURCE.interfaceId}/pages/${SOURCE.pageId}/records`;
    if (init?.method === 'POST' && path === base) {
      const answer: InterfacePageRecords = {
        table: { id: TABLE_ID, name: 'Tasks' },
        fields: opts.fields,
        records: records.map((r) => ({ ...r, fields: { ...r.fields } })),
        offset: 0,
        total: records.length,
        editable: opts.editable,
        canSubmit: false,
        buttons: {},
        ...opts.extra,
      };
      return json(answer);
    }
    if (init?.method === 'PATCH' && path.startsWith(`${base}/`)) {
      const recordId = path.slice(base.length + 1);
      const body = JSON.parse(String(init.body)) as { fields: Record<string, unknown> };
      writes.push({ recordId, fields: body.fields });
      if (opts.refuse) {
        return json(
          { type: 'about:blank', title: 'Forbidden', status: 403, detail: 'Not on this page.' },
          403
        );
      }
      const record = records.find((r) => r.id === recordId);
      if (record) Object.assign(record.fields, body.fields);
      return new Response(null, { status: 204 });
    }
    others.push(`${init?.method ?? 'GET'} ${path}`);
    return json({ type: 'about:blank', title: 'Not found', status: 404 }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { writes, others };
}

function renderPage(config: InterfacePageConfig) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PageRuntime config={config} pageName="Plan" source={SOURCE} />
    </QueryClientProvider>
  );
}

const base = { tableId: TABLE_ID, sorts: [], fields: [], elements: [] };
const dataTransfer = () => ({
  setData: vi.fn(),
  getData: vi.fn(),
  effectAllowed: 'all',
  dropEffect: 'none',
});

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('kanban, calendar and timeline interface pages', () => {
  const kanban: InterfacePageConfig = {
    ...base,
    layout: 'kanban',
    kanban: { stackFieldId: stage.id, cardFields: [] },
  };
  const boardRecords: SharedRecord[] = [
    { id: uuid(11), fields: { [name.id]: 'Alpha', [stage.id]: 'open' } },
    { id: uuid(12), fields: { [name.id]: 'Beta', [stage.id]: 'done' } },
  ];
  const kanbanExtra = { kanban: { stackFieldId: stage.id, cardFields: [], coverFieldId: null } };

  it('drags a card to another stack through the page', async () => {
    const page = fakePage({
      fields: [name, stage],
      records: boardRecords,
      editable: [stage.id],
      extra: kanbanExtra,
    });
    renderPage(kanban);
    const open = await screen.findByRole('region', { name: 'Open' });
    const card = within(open).getByRole('article', { name: 'Alpha' });
    expect(card.getAttribute('draggable')).toBe('true');
    const done = screen.getByRole('region', { name: 'Done' });
    const dt = dataTransfer();
    fireEvent.dragStart(card, { dataTransfer: dt });
    fireEvent.dragOver(done, { dataTransfer: dt });
    fireEvent.drop(done, { dataTransfer: dt });
    await waitFor(() =>
      expect(page.writes).toEqual([{ recordId: uuid(11), fields: { [stage.id]: 'done' } }])
    );
    // The records come back with the card in its new stack.
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'Done' })).getByRole('article', {
          name: 'Alpha',
        })
      ).toBeTruthy()
    );
    // Alt+Left moves it back by a stack, from the keyboard.
    fireEvent.keyDown(
      within(screen.getByRole('region', { name: 'Done' })).getByRole('article', { name: 'Alpha' }),
      { key: 'ArrowLeft', altKey: true }
    );
    await waitFor(() => expect(page.writes).toHaveLength(2));
    expect(page.writes[1]).toEqual({ recordId: uuid(11), fields: { [stage.id]: 'open' } });
    expect(page.others).toEqual([]);
  });

  it('puts a refused card back where it was', async () => {
    const page = fakePage({
      fields: [name, stage],
      records: boardRecords,
      editable: [stage.id],
      extra: kanbanExtra,
      refuse: true,
    });
    renderPage(kanban);
    const open = await screen.findByRole('region', { name: 'Open' });
    const card = within(open).getByRole('article', { name: 'Alpha' });
    const done = screen.getByRole('region', { name: 'Done' });
    const dt = dataTransfer();
    fireEvent.dragStart(card, { dataTransfer: dt });
    fireEvent.dragOver(done, { dataTransfer: dt });
    fireEvent.drop(done, { dataTransfer: dt });
    await waitFor(() => expect(page.writes).toHaveLength(1));
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'Open' })).getByRole('article', {
          name: 'Alpha',
        })
      ).toBeTruthy()
    );
    expect(
      within(screen.getByRole('region', { name: 'Done' })).queryByRole('article', {
        name: 'Alpha',
      })
    ).toBeNull();
  });

  it("doesn't drag when the server lists no editable fields, or the board stacks by people", async () => {
    const page = fakePage({
      fields: [name, stage],
      records: boardRecords,
      editable: [],
      extra: kanbanExtra,
    });
    renderPage(kanban);
    const open = await screen.findByRole('region', { name: 'Open' });
    const card = within(open).getByRole('article', { name: 'Alpha' });
    expect(card.getAttribute('draggable')).toBeNull();
    const done = screen.getByRole('region', { name: 'Done' });
    const dt = dataTransfer();
    fireEvent.dragStart(card, { dataTransfer: dt });
    fireEvent.drop(done, { dataTransfer: dt });
    fireEvent.keyDown(card, { key: 'ArrowRight', altKey: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(page.writes).toEqual([]);
  });

  it("doesn't drag a board stacked by people, even with the field listed", async () => {
    const page = fakePage({
      fields: [name, owner],
      records: [{ id: uuid(11), fields: { [name.id]: 'Alpha', [owner.id]: ['Gus'] } }],
      editable: [owner.id],
      extra: { kanban: { stackFieldId: owner.id, cardFields: [], coverFieldId: null } },
    });
    renderPage({ ...base, layout: 'kanban', kanban: { stackFieldId: owner.id, cardFields: [] } });
    const card = await screen.findByRole('article', { name: 'Alpha' });
    expect(card.getAttribute('draggable')).toBeNull();
    fireEvent.keyDown(card, { key: 'ArrowLeft', altKey: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(page.writes).toEqual([]);
  });

  it("doesn't drag on a share link", async () => {
    const shared: SharedView = {
      view: { name: 'Board', type: 'kanban' },
      table: { name: 'Tasks' },
      fields: [name, stage],
      layout: {},
      kanban: { stackFieldId: stage.id, cardFields: [], coverFieldId: null },
      expiresAt: null,
    };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <SharedLayout
          token={'L'.repeat(43)}
          viewId={uuid(200)}
          shared={shared}
          records={() =>
            queryOptions({
              queryKey: ['share-test'] as readonly unknown[],
              queryFn: async () => ({ records: boardRecords, total: 2 }),
            })
          }
        />
      </QueryClientProvider>
    );
    const open = await screen.findByRole('region', { name: 'Open' });
    const card = within(open).getByRole('article', { name: 'Alpha' });
    expect(card.getAttribute('draggable')).toBeNull();
    expect(card.getAttribute('tabindex')).toBeNull();
    const dt = dataTransfer();
    fireEvent.dragStart(card, { dataTransfer: dt });
    fireEvent.drop(screen.getByRole('region', { name: 'Done' }), { dataTransfer: dt });
    fireEvent.keyDown(card, { key: 'ArrowRight', altKey: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const today = localToday();
  const calendarRecords: SharedRecord[] = [
    {
      id: uuid(21),
      fields: { [name.id]: 'Launch', [start.id]: today, [end.id]: addDays(today, 1) },
    },
  ];
  const calendar: InterfacePageConfig = {
    ...base,
    layout: 'calendar',
    calendar: { mode: 'week', dateFields: [{ startFieldId: start.id, endFieldId: end.id }] },
  };
  const calendarExtra = {
    calendar: {
      mode: 'week' as const,
      dateFields: [{ startFieldId: start.id, endFieldId: end.id }],
      colorFieldId: null,
    },
  };

  it('drags a calendar event to another day, and changes its end from the keyboard', async () => {
    const page = fakePage({
      fields: [name, start, end],
      records: calendarRecords,
      editable: [start.id, end.id],
      extra: calendarExtra,
    });
    renderPage(calendar);
    const event = await screen.findByRole('button', { name: /Launch/ });
    const row = event.closest<HTMLElement>('[data-days]');
    const days = row?.dataset['days']?.split(',') ?? [];
    expect(days).toContain(today);
    if (!row) throw new Error('no week row');
    // Seven columns of 100 px.
    row.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 700, height: 100, right: 700, bottom: 100 }) as DOMRect;
    const from = days.indexOf(today);
    const to = from < 5 ? from + 1 : from - 1;
    const dt = dataTransfer();
    // jsdom has no DragEvent: the pointer's x is set on the event.
    const at = (el: HTMLElement, type: 'dragStart' | 'dragOver' | 'drop', clientX: number) => {
      const e = createEvent[type](el, { dataTransfer: dt });
      Object.defineProperty(e, 'clientX', { value: clientX });
      fireEvent(el, e);
    };
    at(event, 'dragStart', from * 100 + 50);
    at(row, 'dragOver', to * 100 + 50);
    at(row, 'drop', to * 100 + 50);
    const shift = to - from;
    await waitFor(() =>
      expect(page.writes).toEqual([
        {
          recordId: uuid(21),
          fields: { [start.id]: addDays(today, shift), [end.id]: addDays(today, 1 + shift) },
        },
      ])
    );
    // Alt+Shift+Right lengthens the range by a day.
    const moved = await screen.findByRole('button', { name: /Launch/ });
    await waitFor(() =>
      expect(moved.getAttribute('data-event-start') ?? '').toBe(addDays(today, shift))
    );
    fireEvent.keyDown(screen.getByRole('button', { name: /Launch/ }), {
      key: 'ArrowRight',
      altKey: true,
      shiftKey: true,
    });
    await waitFor(() => expect(page.writes).toHaveLength(2));
    expect(page.writes[1]).toEqual({
      recordId: uuid(21),
      fields: { [end.id]: addDays(today, 2 + shift) },
    });
  });

  it("doesn't move a calendar event whose end field the page doesn't let the viewer write", async () => {
    const page = fakePage({
      fields: [name, start, end],
      records: calendarRecords,
      editable: [start.id],
      extra: calendarExtra,
    });
    renderPage(calendar);
    await screen.findByText('Launch');
    expect(screen.queryByRole('button', { name: /Launch/ })).toBeNull();
    expect(document.querySelector('[draggable="true"]')).toBeNull();
    expect(page.writes).toEqual([]);
  });

  const timeline: InterfacePageConfig = {
    ...base,
    layout: 'timeline',
    timeline: { startFieldId: start.id, endFieldId: end.id, scale: 'week' },
  };
  const timelineExtra = {
    timeline: {
      startFieldId: start.id,
      endFieldId: end.id,
      scale: 'week' as const,
      dependencyFieldId: null,
    },
  };

  it('drags a timeline bar to move it, and an edge to change its dates', async () => {
    const page = fakePage({
      fields: [name, start, end],
      records: calendarRecords,
      editable: [start.id, end.id],
      extra: timelineExtra,
    });
    renderPage(timeline);
    const bar = await screen.findByRole('button', { name: /Launch/ });
    const { px } = SCALES.week;
    fireEvent.pointerDown(bar, { button: 0, clientX: 10, pointerId: 1 });
    fireEvent.pointerMove(bar, { clientX: 10 + 2 * px, pointerId: 1 });
    fireEvent.pointerUp(bar, { clientX: 10 + 2 * px, pointerId: 1 });
    await waitFor(() =>
      expect(page.writes).toEqual([
        {
          recordId: uuid(21),
          fields: { [start.id]: addDays(today, 2), [end.id]: addDays(today, 3) },
        },
      ])
    );
    const handle = screen
      .getByRole('button', { name: /Launch/ })
      .querySelector<HTMLElement>('[data-resize="end"]');
    if (!handle) throw new Error('no end handle');
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 2 });
    fireEvent.pointerMove(handle, { clientX: 100 + px, pointerId: 2 });
    fireEvent.pointerUp(handle, { clientX: 100 + px, pointerId: 2 });
    await waitFor(() => expect(page.writes).toHaveLength(2));
    expect(page.writes[1]).toEqual({ recordId: uuid(21), fields: { [end.id]: addDays(today, 4) } });
  });

  it('draws timeline bars read-only when the server lists no editable fields', async () => {
    const page = fakePage({
      fields: [name, start, end],
      records: calendarRecords,
      editable: [],
      extra: timelineExtra,
    });
    renderPage(timeline);
    const list = await screen.findByRole('list', { name: 'Plan' });
    expect(await within(list).findAllByText('Launch')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Launch/ })).toBeNull();
    const bar = document.querySelector<HTMLElement>('[data-bar]');
    if (!bar) throw new Error('no bar');
    fireEvent.pointerDown(bar, { button: 0, clientX: 10 });
    fireEvent.pointerMove(bar, { clientX: 100 });
    fireEvent.pointerUp(bar, { clientX: 100 });
    await new Promise((r) => setTimeout(r, 20));
    expect(page.writes).toEqual([]);
  });
});

describe('hierarchical list interface pages', () => {
  const parent = uuid(6);
  const notes: SharedField = {
    id: uuid(7),
    name: 'Details',
    type: 'singleLineText',
    options: {},
    isPrimary: false,
  };
  const secretId = uuid(8);
  const config: InterfacePageConfig = {
    ...base,
    layout: 'list',
    fields: [notes.id, secretId],
    list: { parentFieldId: parent },
  };
  const ids = { epic: uuid(31), task: uuid(32), sub: uuid(33), orphan: uuid(34) };
  // As the server answers: the parent link as ids of listed records only (the orphan's parent
  // isn't listed, so it comes as a root), and only the fields the page shows this viewer.
  const treeRecords: SharedRecord[] = [
    { id: ids.epic, fields: { [name.id]: 'Epic', [notes.id]: 'top' }, links: { [parent]: [] } },
    {
      id: ids.task,
      fields: { [name.id]: 'Task', [notes.id]: 'middle' },
      links: { [parent]: [ids.epic] },
    },
    {
      id: ids.sub,
      fields: { [name.id]: 'Sub', [notes.id]: 'leaf' },
      links: { [parent]: [ids.task] },
    },
    { id: ids.orphan, fields: { [name.id]: 'Orphan', [notes.id]: null }, links: { [parent]: [] } },
  ];
  const listExtra = { list: { parentFieldId: parent, rowFields: [notes.id] } };

  /** The rows' titles in order, with their depth (by indentation). */
  const rowsOf = (list: HTMLElement) =>
    within(list)
      .getAllByRole('listitem')
      .map((li) => `${li.style.paddingLeft} ${li.querySelector('.truncate')?.textContent}`);

  it('nests the listed records under their parent, and collapses a parent', async () => {
    const page = fakePage({
      fields: [name, notes],
      records: treeRecords,
      editable: [],
      extra: listExtra,
    });
    renderPage(config);
    const list = await screen.findByRole('list', { name: 'Plan' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(4));
    expect(rowsOf(list)).toEqual(['12px Epic', '32px Task', '52px Sub', '12px Orphan']);
    expect(within(list).getByText('middle')).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'Collapse Epic' }));
    expect(rowsOf(list)).toEqual(['12px Epic', '12px Orphan']);
    fireEvent.click(within(list).getByRole('button', { name: 'Expand Epic' }));
    expect(rowsOf(list)).toHaveLength(4);
    expect(page.writes).toEqual([]);
    expect(page.others).toEqual([]);
  });

  it("shows nothing the server left out, and nests nothing without the parent's structure", async () => {
    // Values of a field the server doesn't list never render, nor a parent it doesn't list.
    fakePage({
      fields: [name, notes],
      records: [
        { id: ids.task, fields: { [name.id]: 'Task', [secretId]: 'TOP-SECRET' }, links: {} },
        { id: ids.sub, fields: { [name.id]: 'Sub' }, links: { [parent]: [ids.epic] } },
      ],
      editable: [],
      extra: { list: { parentFieldId: null, rowFields: [notes.id] } },
    });
    renderPage(config);
    const list = await screen.findByRole('list', { name: 'Plan' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    expect(rowsOf(list)).toEqual(['12px Task', '12px Sub']);
    expect(screen.queryByText('TOP-SECRET')).toBeNull();
    expect(screen.queryByText('Epic')).toBeNull();
    expect(screen.queryByRole('button', { name: /Collapse/ })).toBeNull();
  });
});

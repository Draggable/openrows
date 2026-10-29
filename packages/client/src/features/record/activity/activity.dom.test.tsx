import type {
  Collaborator,
  FieldMeta,
  FieldTypeName,
  Revision,
  TableMeta,
  UserRole,
} from '@openrows/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../components/ui';
import { type Directory, DirectoryContext } from '../../collaborators/context';
import { ActivityPanel } from './ActivityPanel';

const NOW = '2026-10-25T10:00:00.000Z';
const TABLE = '0190a000-0000-7000-8000-000000000001';
const REC = '0190a000-0000-7000-8000-000000000002';
const ME = '0190a000-0000-7000-8000-0000000000a1';
const ADA = '0190a000-0000-7000-8000-0000000000a2';
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const field = (n: number, name: string, type: FieldTypeName, extra: Partial<FieldMeta> = {}) =>
  ({
    id: id(100 + n),
    tableId: TABLE,
    name,
    description: null,
    type,
    options: {},
    isPrimary: n === 1,
    position: n,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...extra,
  }) as FieldMeta;

const STATUS = field(1, 'Status', 'singleLineText');
const BUDGET = field(2, 'Budget', 'number', {
  permissions: { edit: { level: 'creators' } },
} as Partial<FieldMeta>);
const table = { id: TABLE, baseId: id(9), name: 'Tasks', fields: [STATUS, BUDGET] } as TableMeta;

const person = (pid: string, name: string): Collaborator => ({
  id: pid,
  name,
  initials: name.slice(0, 2).toUpperCase(),
  color: 'green',
});
const people = [person(ME, 'Me Myself'), person(ADA, 'Ada Lovelace')];
const directory: Directory = {
  list: people,
  byId: new Map(people.map((p) => [p.id, p])),
  meId: ME,
  loaded: true,
};

const REV = id(500);
const revisions: Revision[] = [
  {
    id: REV,
    recordId: REC,
    kind: 'updated',
    actorId: ADA,
    at: '2026-10-25T11:00:00.000Z',
    changes: [
      { fieldId: STATUS.id, type: 'singleLineText', before: 'Open', after: 'Done' },
      { fieldId: BUDGET.id, type: 'number', before: null, after: 5 },
    ],
    restoredFrom: null,
    via: null,
  },
  {
    id: id(501),
    recordId: REC,
    kind: 'created',
    actorId: ME,
    at: '2026-10-25T09:00:00.000Z',
    changes: [],
    restoredFrom: null,
    via: null,
  },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

function show(role: UserRole, list: Revision[] = revisions) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/revisions') && init?.method === 'POST') {
      return json({
        id: REC,
        tableId: TABLE,
        version: 3,
        fields: { [STATUS.id]: 'Done' },
        createdAt: NOW,
        createdBy: null,
        updatedAt: NOW,
        updatedBy: ME,
      });
    }
    if (url.includes('/revisions')) return json({ revisions: list, nextCursor: null });
    if (url.includes('/comments')) {
      return json({
        comments: [
          {
            id: id(600),
            tableId: TABLE,
            recordId: REC,
            authorId: ME,
            body: 'Looks right',
            mentions: [],
            reactions: [],
            createdAt: '2026-10-25T10:00:00.000Z',
            editedAt: null,
          },
        ],
        previousCursor: null,
      });
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <DirectoryContext.Provider value={directory}>
          <ActivityPanel table={table} fields={table.fields} recordId={REC} userRole={role} />
        </DirectoryContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>
  );
  return { fetchMock };
}

describe('ActivityPanel (#94)', () => {
  it('shows revisions and comments oldest first, with values before and after', async () => {
    show('editor');
    const entries = await screen.findAllByTestId('activity-entry');
    expect(entries.map((e) => e.dataset['kind'])).toEqual(['created', 'comment', 'updated']);
    expect(within(entries[0] as HTMLElement).getByText('created this record')).toBeTruthy();
    expect(within(entries[1] as HTMLElement).getByText('Looks right')).toBeTruthy();
    const update = entries[2] as HTMLElement;
    expect(within(update).getByText('Ada Lovelace')).toBeTruthy();
    expect(within(update).getByText('changed Status and Budget')).toBeTruthy();
    const [status, budget] = within(update).getAllByTestId('activity-change');
    expect(within(status as HTMLElement).getByTestId('activity-before').textContent).toContain(
      'Open'
    );
    expect(within(status as HTMLElement).getByTestId('activity-after').textContent).toContain(
      'Done'
    );
    expect(within(budget as HTMLElement).getByText('empty')).toBeTruthy();
  });

  it('offers restores the edit permissions allow, and sends them', async () => {
    const { fetchMock } = show('editor');
    const update = (await screen.findAllByTestId('activity-entry'))[2] as HTMLElement;
    // Budget is creators-only: no restore of its value for an editor.
    expect(
      within(update).queryByRole('button', { name: 'Restore this value of Budget' })
    ).toBeNull();
    await userEvent.click(
      within(update).getByRole('button', { name: 'Restore this value of Status' })
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/tables/${TABLE}/records/${REC}/revisions/${REV}/restore`,
        expect.objectContaining({ method: 'POST' })
      )
    );
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/restore'));
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ fieldId: STATUS.id });
    await userEvent.click(
      within(update).getByRole('button', { name: 'Restore record to this point' })
    );
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/restore'))).toHaveLength(
        2
      )
    );
    const last = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/restore')).at(-1);
    expect(JSON.parse(String(last?.[1]?.body)).fieldId).toBeUndefined();
  });

  it('read-only members and commenters see the history without restores', async () => {
    show('commenter');
    await screen.findAllByTestId('activity-entry');
    expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull();
  });

  it('wraps the actor and verb, and gives a long value its whole text on hover (#119)', async () => {
    const long = 'Launch plan for the October release, second draft';
    const [first] = revisions;
    if (!first) throw new Error('fixture');
    show('editor', [
      {
        ...first,
        changes: [{ fieldId: STATUS.id, type: 'singleLineText', before: long, after: 'Done' }],
      },
    ]);
    const entries = await screen.findAllByTestId('activity-entry');
    const entry = entries.find((e) => e.dataset['kind'] === 'updated') as HTMLElement;
    const heading = within(entry).getByText('Ada Lovelace').parentElement as HTMLElement;
    expect(heading.textContent).toBe('Ada Lovelace changed Status');
    expect(heading.className).not.toContain('truncate');
    expect(heading.className).toContain('break-words');
    const before = within(entry).getByTestId('activity-before');
    const after = within(entry).getByTestId('activity-after');
    expect(before.dataset['state']).toBe('closed');
    expect(after.dataset['state']).toBeUndefined();
    await userEvent.hover(before);
    expect((await screen.findByRole('tooltip')).textContent).toBe(long);
  });

  it('names an automation as the actor, and the person it ran as on hover (#126)', async () => {
    const [first] = revisions;
    if (!first) throw new Error('fixture');
    show('editor', [{ ...first, via: 'automation' }]);
    const entries = await screen.findAllByTestId('activity-entry');
    const entry = entries.find((e) => e.dataset['kind'] === 'updated') as HTMLElement;
    const name = within(entry).getByText('Automation');
    expect(name.getAttribute('title')).toBe('Ran as Ada Lovelace');
    expect(within(entry).queryByText('Ada Lovelace')).toBeNull();
  });
});

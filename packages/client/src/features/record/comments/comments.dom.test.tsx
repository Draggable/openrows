import { type Collaborator, type Comment, mentionToken, type UserRole } from '@openrows/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../../components/ui';
import { type Directory, DirectoryContext } from '../../collaborators/context';
import { CommentsPanel } from './CommentsPanel';

const TABLE = '0190a000-0000-7000-8000-000000000001';
const REC = '0190a000-0000-7000-8000-000000000002';
const ME = '0190a000-0000-7000-8000-0000000000a1';
const ADA = '0190a000-0000-7000-8000-0000000000a2';
const GUEST = '0190a000-0000-7000-8000-0000000000a3';

const person = (id: string, name: string): Collaborator => ({
  id,
  name,
  initials: name.slice(0, 2).toUpperCase(),
  color: 'green',
});
const people = [person(ME, 'Me Myself'), person(ADA, 'Ada Lovelace'), person(GUEST, 'Gus Other')];
const directory: Directory = {
  list: people,
  byId: new Map(people.map((p) => [p.id, p])),
  meId: ME,
  loaded: true,
};

const comment = (n: number, body: string, authorId = ADA): Comment => ({
  id: `0190a000-0000-7000-8000-0000000000c${n}`,
  tableId: TABLE,
  recordId: REC,
  authorId,
  body,
  mentions: [],
  reactions: [],
  createdAt: new Date(Date.now() - 60_000 * (10 - n)).toISOString(),
  editedAt: null,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => vi.unstubAllGlobals());

function show(
  comments: Comment[],
  role: UserRole = 'commenter',
  opts: { earlier?: Comment[]; focusCommentId?: string } = {}
) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/mentionable-users')) return json({ userIds: [ME, ADA] });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { body: string };
      return json({ ...comment(9, body.body, ME), mentions: [ADA] }, 201);
    }
    if (url.includes('/comment-counts')) {
      return json({ counts: { [REC]: comments.length + (opts.earlier?.length ?? 0) } });
    }
    if (url.includes('before='))
      return json({ comments: opts.earlier ?? [], previousCursor: null });
    return json({ comments, previousCursor: opts.earlier ? 'page-1' : null });
  });
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <DirectoryContext.Provider value={directory}>
          <CommentsPanel
            tableId={TABLE}
            recordId={REC}
            userRole={role}
            focusCommentId={opts.focusCommentId}
          />
        </DirectoryContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>
  );
  return { fetchMock };
}

describe('CommentsPanel (#92)', () => {
  it('lists comments with the author, mentions by directory name and a count', async () => {
    show([comment(1, `Hey ${mentionToken(ME, 'old name')}, **look**`)]);
    const item = await screen.findByTestId('comment');
    expect(within(item).getByText('Ada Lovelace')).toBeTruthy();
    expect(within(item).getByTestId('mention').textContent).toBe('@Me Myself');
    expect(within(item).getByText('look').closest('strong')).toBeTruthy();
    expect(screen.getByTestId('comments-count').textContent).toBe('1');
  });

  it('never renders HTML or script links from a body (XSS)', async () => {
    show([comment(1, '<img src=x onerror="alert(1)"> [x](javascript:alert(1)) <b>bold</b>')]);
    const item = await screen.findByTestId('comment');
    expect(item.querySelector('img, script, b')).toBeNull();
    for (const a of item.querySelectorAll('a')) expect(a.getAttribute('href')).toMatch(/^https?:/);
    expect(item.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it('suggests people with access after @ and sends the mention as a token', async () => {
    const user = userEvent.setup();
    const { fetchMock } = show([]);
    const box = await screen.findByRole('combobox', { name: 'Write a comment' });
    await user.type(box, 'Ping @');
    const list = await screen.findByRole('listbox', { name: 'People to mention' });
    // Gus has no access to the base: not suggested.
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.querySelector('.truncate')?.textContent)
    ).toEqual(['Me Myself', 'Ada Lovelace']);
    await user.type(box, 'ad');
    await user.keyboard('{Enter}');
    // The pick is a chip in the box, then a space.
    const chip = within(box).getByTestId('mention-chip');
    expect(chip.textContent).toBe('@Ada Lovelace');
    expect(chip.getAttribute('contenteditable')).toBe('false');
    expect(box.textContent).toBe('Ping @Ada Lovelace ');
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.keyboard('please{Control>}{Enter}{/Control}');
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
    );
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe(`/api/tables/${TABLE}/records/${REC}/comments`);
    expect(JSON.parse(String(post?.[1]?.body)).body).toBe(
      `Ping @[Ada Lovelace](user:${ADA}) please`
    );
    expect(await screen.findByText('please', { exact: false })).toBeTruthy();
    expect(box.textContent).toBe('');
  });

  it('deletes a chip whole with Backspace', async () => {
    const user = userEvent.setup();
    show([]);
    const box = await screen.findByRole('combobox', { name: 'Write a comment' });
    await user.type(box, 'Hi @me');
    await screen.findByRole('listbox', { name: 'People to mention' });
    await user.keyboard('{Tab}');
    expect(within(box).getByTestId('mention-chip').textContent).toBe('@Me Myself');
    await user.keyboard('{Backspace}{Backspace}');
    expect(within(box).queryByTestId('mention-chip')).toBeNull();
    expect(box.textContent).toBe('Hi ');
  });

  it('edits a comment with its mentions as chips', async () => {
    const user = userEvent.setup();
    show([comment(2, `Ask ${mentionToken(ADA, 'Ada')} later`, ME)]);
    const item = await screen.findByTestId('comment');
    await user.click(within(item).getByRole('button', { name: 'Comment actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit comment' }));
    const box = await screen.findByRole('combobox', { name: 'Edit comment' });
    expect(within(box).getByTestId('mention-chip').textContent).toBe('@Ada Lovelace');
    expect(box.textContent).toBe('Ask @Ada Lovelace later');
  });

  it('loads earlier comments on demand, newest last (#122)', async () => {
    const user = userEvent.setup();
    const { fetchMock } = show([comment(5, 'Five'), comment(6, 'Six')], 'commenter', {
      earlier: [comment(3, 'Three'), comment(4, 'Four')],
    });
    await screen.findAllByTestId('comment');
    // The thread's size from the table's counts, not just the loaded page.
    await waitFor(() => expect(screen.getByTestId('comments-count').textContent).toBe('4'));
    await user.click(screen.getByRole('button', { name: 'Load earlier comments' }));
    await waitFor(() => expect(screen.getAllByTestId('comment')).toHaveLength(4));
    expect(
      screen.getAllByTestId('comment').map((c) => c.textContent?.match(/Three|Four|Five|Six/)?.[0])
    ).toEqual(['Three', 'Four', 'Five', 'Six']);
    expect(screen.queryByRole('button', { name: 'Load earlier comments' })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('before=page-1'))).toBe(true);
  });

  it('loads earlier pages until a linked comment shows (#93, #122)', async () => {
    show([comment(5, 'Five')], 'commenter', {
      earlier: [comment(3, 'Three')],
      focusCommentId: comment(3, '').id,
    });
    await waitFor(() => expect(screen.getAllByTestId('comment')).toHaveLength(2));
    const linked = screen.getAllByTestId('comment')[0];
    expect(linked?.getAttribute('aria-current')).toBe('true');
  });

  it('says Ctrl/⌘ Enter sends; Enter alone adds a line (#119)', async () => {
    const user = userEvent.setup();
    const { fetchMock } = show([]);
    const box = await screen.findByRole('combobox', { name: 'Write a comment' });
    const hint = document.getElementById(box.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toMatch(/^(Ctrl|⌘) Enter to send$/);
    expect(box.getAttribute('aria-keyshortcuts')).toBe('Control+Enter Meta+Enter');
    await user.type(box, 'one{Enter}two');
    expect(box.textContent).toBe('one\ntwo');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('lets read-only members read but not write, react or delete', async () => {
    show([comment(1, 'Hello')], 'read_only');
    await screen.findByTestId('comment');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add reaction' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Comment actions' })).toBeNull();
    expect(screen.getByText(/You can read comments/)).toBeTruthy();
  });

  it("offers edit only on your own comments, delete on others' only to creators", async () => {
    show([comment(1, 'Theirs'), comment(2, 'Mine', ME)], 'commenter');
    const items = await screen.findAllByTestId('comment');
    expect(
      within(items[0] as HTMLElement).queryByRole('button', { name: 'Comment actions' })
    ).toBeNull();
    expect(
      within(items[1] as HTMLElement).getByRole('button', { name: 'Comment actions' })
    ).toBeTruthy();
  });
});

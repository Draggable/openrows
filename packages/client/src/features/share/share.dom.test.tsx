import type { Share, SharedField, SharedRecord, SharedShare, SharedView } from '@openrows/shared';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '../../router';
import { stubApi } from '../../test/fakeApi';
import { ME } from '../../test/me';
import {
  embedSnippet,
  embedUrl,
  expiryOf,
  parseDomains,
  parseEmbedOrigins,
  shareBadges,
  shareSummary,
  shareUrl,
} from './model';

function renderApp(path: string) {
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

const now = '2026-10-25T10:00:00.000Z';

async function seed(api: ReturnType<typeof stubApi>, role: 'owner' | 'editor') {
  const ws = { id: crypto.randomUUID(), name: 'Acme', role };
  api.workspaces.push({ ...ws, createdAt: now, updatedAt: now });
  const base = {
    id: crypto.randomUUID(),
    workspaceId: ws.id,
    name: 'Roadmap',
    description: null,
    icon: null,
    color: null,
    role,
    createdAt: now,
    updatedAt: now,
  };
  api.bases.push(base);
  await fetch(`/api/bases/${base.id}/tables`, { method: 'POST', body: '{"name":"Tasks"}' });
  return base;
}

const SHARED: SharedView = {
  view: { name: 'Launch plan', type: 'grid' },
  table: { name: 'Tasks' },
  fields: [
    {
      id: '01900000-0000-7000-8000-000000000001',
      name: 'Name',
      type: 'singleLineText',
      options: {},
      isPrimary: true,
    },
    {
      id: '01900000-0000-7000-8000-000000000002',
      name: 'Owner',
      type: 'user',
      options: {},
      isPrimary: false,
    },
    {
      id: '01900000-0000-7000-8000-000000000003',
      name: 'Project',
      type: 'link',
      options: {},
      isPrimary: false,
    },
  ],
  layout: {},
  expiresAt: null,
};

const VIEW_ID = '01900000-0000-7000-8000-0000000000f1';
const RECORD: SharedRecord = {
  id: '01900000-0000-7000-8000-0000000000a1',
  fields: {
    [SHARED.fields[0]?.id ?? '']: 'Ship it',
    [SHARED.fields[1]?.id ?? '']: ['Olive Owner'],
    [SHARED.fields[2]?.id ?? '']: ['Apollo'],
  },
};

/** A view link's summary, as the server answers it. */
function viewShare(over: Partial<SharedShare> = {}): SharedShare {
  return {
    kind: 'view',
    name: 'Launch plan',
    tables: [{ name: 'Tasks', views: [{ id: VIEW_ID, name: 'Launch plan', type: 'grid' }] }],
    allowCopy: true,
    allowDownload: false,
    expiresAt: null,
    ...over,
  };
}

/** jsdom lays nothing out: give scrollers a size, so the virtualizer draws rows. */
function sized() {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
}

describe('view share links (#97)', () => {
  beforeAll(() => {
    window.matchMedia ??= ((q: string) => ({
      matches: false,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.head.querySelectorAll('meta[name="robots"]').forEach((m) => {
      m.remove();
    });
  });

  it('makes a link from the view menu, shows it once, and revokes it', async () => {
    const api = stubApi(ME);
    const base = await seed(api, 'owner');
    renderApp(`/b/${base.id}`);
    const nav = await screen.findByRole('navigation', { name: 'Views' });
    await within(nav).findByRole('link', { name: 'Grid view' });
    fireEvent.keyDown(within(nav).getByRole('button', { name: 'Grid view options' }), {
      key: 'Enter',
    });
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Share view' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share Grid view' });
    expect(await within(dialog).findByText('No links yet.')).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('Expires (optional)'), {
      target: { value: '2030-01-31' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create link' }));
    const link = (await within(dialog).findByLabelText(/New link/)) as HTMLInputElement;
    expect(link.value).toBe(`${window.location.origin}/s/${'T'.repeat(43)}`);
    expect(api.shares[0]?.['expiresAt']).toBe(expiryOf('2030-01-31'));
    expect(api.shares[0]?.['allowCopy']).toBe(true);
    expect(api.shares[0]?.['allowDownload']).toBe(false);
    expect(api.shares[0]?.['hasPassword']).toBe(false);
    const list = await within(dialog).findByRole('list', { name: 'Share links' });
    expect(list.textContent).toContain('Expires');

    fireEvent.click(within(list).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(api.shares).toHaveLength(0));
    expect(await within(dialog).findByText('No links yet.')).toBeTruthy();
    expect(within(dialog).queryByLabelText(/New link/)).toBeNull();
  });

  it('makes a link with a password, domains and toggles, then changes them (#98)', async () => {
    const api = stubApi(ME);
    const base = await seed(api, 'owner');
    renderApp(`/b/${base.id}`);
    const nav = await screen.findByRole('navigation', { name: 'Views' });
    await within(nav).findByRole('link', { name: 'Grid view' });
    fireEvent.keyDown(within(nav).getByRole('button', { name: 'Grid view options' }), {
      key: 'Enter',
    });
    fireEvent.click(
      within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Share view' })
    );
    const dialog = await screen.findByRole('dialog', { name: 'Share Grid view' });
    await within(dialog).findByText('No links yet.');

    const form = within(dialog).getByRole('form', { name: 'New share link' });
    fireEvent.change(within(form).getByLabelText('Password (optional)'), {
      target: { value: 'short' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Create link' }));
    expect((await within(form).findByRole('alert')).textContent).toContain('at least 8');
    expect(api.shares).toHaveLength(0);

    fireEvent.change(within(form).getByLabelText('Password (optional)'), {
      target: { value: 'long enough secret' },
    });
    fireEvent.change(within(form).getByLabelText(/Only people signed in/), {
      target: { value: 'evil example' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Create link' }));
    expect((await within(form).findByRole('alert')).textContent).toContain('isn’t a domain');

    fireEvent.change(within(form).getByLabelText(/Only people signed in/), {
      target: { value: 'Example.com, example.org' },
    });
    fireEvent.click(within(form).getByLabelText('Allow copying data out'));
    fireEvent.click(within(form).getByLabelText('Allow CSV download'));
    fireEvent.click(within(form).getByRole('button', { name: 'Create link' }));
    await within(dialog).findByLabelText(/New link/);
    const posted = api.fetch.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)))
      .at(-1);
    expect(posted).toMatchObject({
      password: 'long enough secret',
      allowedDomains: ['example.com', 'example.org'],
      allowCopy: false,
      allowDownload: true,
    });
    const list = await within(dialog).findByRole('list', { name: 'Share links' });
    expect(list.textContent).toContain('Password · Only example.com, example.org · No copying');

    fireEvent.click(within(list).getByRole('button', { name: 'Settings' }));
    const edit = within(list).getByRole('form', { name: 'Link settings' });
    fireEvent.click(within(edit).getByLabelText('Remove the password'));
    fireEvent.click(within(edit).getByLabelText('Allow copying data out'));
    fireEvent.click(within(edit).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.shares[0]?.['hasPassword']).toBe(false));
    expect(api.shares[0]?.['allowCopy']).toBe(true);
    const patched = api.fetch.mock.calls
      .filter(([, init]) => init?.method === 'PATCH')
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(patched).toEqual([
      {
        password: null,
        allowedDomains: ['example.com', 'example.org'],
        allowCopy: true,
        allowDownload: true,
        embedOrigins: [],
        allowRestrictedEmbed: false,
      },
    ]);
  });

  it('makes an embeddable link and shows its embed code with a theme (#99)', async () => {
    const api = stubApi(ME);
    const base = await seed(api, 'owner');
    renderApp(`/b/${base.id}`);
    const nav = await screen.findByRole('navigation', { name: 'Views' });
    await within(nav).findByRole('link', { name: 'Grid view' });
    fireEvent.keyDown(within(nav).getByRole('button', { name: 'Grid view options' }), {
      key: 'Enter',
    });
    fireEvent.click(
      within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Share view' })
    );
    const dialog = await screen.findByRole('dialog', { name: 'Share Grid view' });
    await within(dialog).findByText('No links yet.');
    const form = within(dialog).getByRole('form', { name: 'New share link' });
    const sites = within(form).getByLabelText(/Sites that may embed it/);

    fireEvent.change(sites, { target: { value: 'http://intranet.example.com' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create link' }));
    expect((await within(form).findByRole('alert')).textContent).toContain('https origin');
    expect(api.shares).toHaveLength(0);

    // A password asks whether to embed anyway; by default it isn't.
    fireEvent.change(sites, {
      target: { value: 'https://Intranet.Example.com/, https://wiki.example.org' },
    });
    fireEvent.change(within(form).getByLabelText('Password (optional)'), {
      target: { value: 'long enough secret' },
    });
    expect(within(form).getByLabelText(/Allow embedding even with a password/)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('Password (optional)'), {
      target: { value: '' },
    });
    expect(within(form).queryByLabelText(/Allow embedding even with a password/)).toBeNull();

    fireEvent.click(within(form).getByRole('button', { name: 'Create link' }));
    const code = (await within(dialog).findByLabelText('Embed code')) as HTMLTextAreaElement;
    const posted = api.fetch.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)))
      .at(-1);
    expect(posted).toMatchObject({
      embedOrigins: ['https://intranet.example.com', 'https://wiki.example.org'],
      allowRestrictedEmbed: false,
    });
    expect(code.value).toContain(
      `src="${window.location.origin}/embed/${'T'.repeat(43)}?theme=light"`
    );
    expect(code.value).toContain('title="Grid view"');
    fireEvent.change(within(dialog).getByLabelText('Theme'), { target: { value: 'dark' } });
    expect(code.value).toContain('?theme=dark');
    const list = await within(dialog).findByRole('list', { name: 'Share links' });
    expect(list.textContent).toContain('Embeddable on 2 sites');
  });

  it('shows an embedded link compactly in its theme, without touching the saved one (#99)', async () => {
    const api = stubApi(ME);
    const token = 'E'.repeat(43);
    api.shared[token] = {
      share: viewShare(),
      views: { [VIEW_ID]: { view: SHARED, records: [RECORD] } },
    };
    sized();
    localStorage.setItem('openrows-theme', 'light');
    renderApp(`/embed/${token}?theme=dark`);
    const table = await screen.findByRole('table', { name: 'Launch plan' });
    expect(await within(table).findByText('Ship it')).toBeTruthy();
    expect(api.calls).not.toContain('GET /api/me');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('openrows-theme')).toBe('light');
    const full = screen.getByRole('link', { name: /View in OpenRows/ });
    expect(full.getAttribute('href')).toBe(`/s/${token}`);
    expect(full.getAttribute('target')).toBe('_blank');
    expect(screen.queryByText(/Made with/)).toBeNull();
    cleanup();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    localStorage.removeItem('openrows-theme');
  });

  it('offers Share view only to creators and owners', async () => {
    const api = stubApi(ME);
    const base = await seed(api, 'editor');
    renderApp(`/b/${base.id}`);
    const nav = await screen.findByRole('navigation', { name: 'Views' });
    await within(nav).findByRole('link', { name: 'Grid view' });
    fireEvent.keyDown(within(nav).getByRole('button', { name: 'Grid view options' }), {
      key: 'Enter',
    });
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Share view' })).toBeNull();
  });

  it('shows a shared view read-only, signed out, with names for people and links', async () => {
    const api = stubApi(ME);
    const token = 'S'.repeat(43);
    api.shared[token] = {
      share: viewShare(),
      views: { [VIEW_ID]: { view: SHARED, records: [RECORD] } },
    };
    sized();
    renderApp(`/s/${token}`);
    const table = await screen.findByRole('table', { name: 'Launch plan' });
    expect(await within(table).findByText('Ship it')).toBeTruthy();
    expect(within(table).getByText('Olive Owner')).toBeTruthy();
    expect(within(table).getByText('Apollo')).toBeTruthy();
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent)
    ).toEqual(['Name', 'Owner', 'Project']);
    expect(screen.getByText('1 record')).toBeTruthy();
    expect(screen.getByRole('link', { name: /^Made with OpenRows$/ })).toBeTruthy();
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toContain(
      'noindex'
    );
    // No session needed: /api/me is never asked.
    expect(api.calls).not.toContain('GET /api/me');
    expect(screen.queryByRole('textbox')).toBeNull();
    // Copying allowed, downloads off by default.
    expect(screen.queryByRole('link', { name: /Download CSV/ })).toBeNull();
    const copy = new Event('copy', { bubbles: true, cancelable: true });
    table.dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(false);
  });

  it('asks for the password first and shows nothing until it is right (#98)', async () => {
    const api = stubApi(ME);
    const token = 'P'.repeat(43);
    api.shared[token] = {
      share: viewShare(),
      views: { [VIEW_ID]: { view: SHARED, records: [RECORD] } },
      password: 'correct horse',
    };
    sized();
    renderApp(`/s/${token}`);
    await screen.findByRole('heading', { name: 'This link is password protected' });
    const input = screen.getByLabelText('Password');
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('Ship it')).toBeNull();

    fireEvent.change(input, { target: { value: 'wrong one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Incorrect password');
    expect(screen.queryByRole('table')).toBeNull();

    fireEvent.change(input, { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const table = await screen.findByRole('table', { name: 'Launch plan' });
    expect(await within(table).findByText('Ship it')).toBeTruthy();
    expect(api.calls).toContain(`POST /api/shared/${token}/unlock`);
  });

  it('asks a domain-limited link to sign in, and refuses other accounts (#98)', async () => {
    const api = stubApi(ME);
    const token = 'D'.repeat(43);
    api.shared[token] = {
      share: viewShare(),
      views: {},
      refuse: 'SHARE_SIGN_IN_REQUIRED',
    };
    renderApp(`/s/${token}`);
    const signIn = await screen.findByRole('link', { name: 'Sign in to view' });
    expect(signIn.getAttribute('href')).toBe(
      `/auth/login?returnTo=${encodeURIComponent(`/s/${token}`)}`
    );
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('tells a signed-in user at another domain the link is not for them (#98)', async () => {
    const api = stubApi(ME);
    const token = 'E'.repeat(43);
    api.shared[token] = { share: viewShare(), views: {}, refuse: 'SHARE_DOMAIN_NOT_ALLOWED' };
    renderApp(`/s/${token}`);
    expect(
      await screen.findByRole('heading', { name: 'Your account can’t open this link' })
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Sign in to view' })).toBeNull();
  });

  it('blocks copying and offers the CSV download as the link says (#98)', async () => {
    const api = stubApi(ME);
    const token = 'C'.repeat(43);
    api.shared[token] = {
      share: viewShare({ allowCopy: false, allowDownload: true }),
      views: { [VIEW_ID]: { view: SHARED, records: [RECORD] } },
    };
    sized();
    renderApp(`/s/${token}`);
    const table = await screen.findByRole('table', { name: 'Launch plan' });
    await within(table).findByText('Ship it');
    const copy = new Event('copy', { bubbles: true, cancelable: true });
    table.dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(true);
    expect(screen.getByRole('main').className).toContain('select-none');
    const download = screen.getByRole('link', { name: /Download CSV/ });
    expect(download.getAttribute('href')).toBe(`/api/shared/${token}/views/${VIEW_ID}/export.csv`);
  });

  it('shows a base link as table tabs with a view picker (#98)', async () => {
    const api = stubApi(ME);
    const token = 'B'.repeat(43);
    const other = '01900000-0000-7000-8000-0000000000f2';
    const third = '01900000-0000-7000-8000-0000000000f3';
    api.shared[token] = {
      share: {
        kind: 'base',
        name: 'Roadmap',
        tables: [
          {
            name: 'Tasks',
            views: [
              { id: VIEW_ID, name: 'Launch plan', type: 'grid' },
              { id: third, name: 'Done', type: 'grid' },
            ],
          },
          { name: 'Projects', views: [{ id: other, name: 'All projects', type: 'grid' }] },
        ],
        allowCopy: true,
        allowDownload: false,
        expiresAt: null,
      },
      views: {
        [VIEW_ID]: { view: SHARED, records: [RECORD] },
        [third]: { view: { ...SHARED, view: { name: 'Done', type: 'grid' } }, records: [] },
        [other]: {
          view: { ...SHARED, view: { name: 'All projects', type: 'grid' } },
          records: [
            {
              id: '01900000-0000-7000-8000-0000000000b1',
              fields: { [SHARED.fields[0]?.id ?? '']: 'Apollo' },
            },
          ],
        },
      },
    };
    sized();
    const router = renderApp(`/s/${token}`);
    expect(await screen.findByRole('heading', { name: 'Roadmap' })).toBeTruthy();
    const tabs = screen.getByRole('tablist', { name: 'Tables' });
    expect(within(tabs).getByRole('tab', { name: 'Tasks' }).getAttribute('aria-selected')).toBe(
      'true'
    );
    await screen.findByRole('table', { name: 'Launch plan' });

    fireEvent.change(screen.getByLabelText('View'), { target: { value: third } });
    expect(await screen.findByRole('table', { name: 'Done' })).toBeTruthy();
    expect(router.state.location.search).toEqual({ view: third });

    fireEvent.click(within(tabs).getByRole('tab', { name: 'Projects' }));
    const projects = await screen.findByRole('table', { name: 'All projects' });
    expect(await within(projects).findByText('Apollo')).toBeTruthy();
    expect(screen.queryByLabelText('View')).toBeNull();
  });

  describe('other layouts (#120)', () => {
    const uuidOf = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
    const name: SharedField = {
      id: uuidOf(901),
      name: 'Name',
      type: 'singleLineText',
      options: {},
      isPrimary: true,
    };
    const status = {
      id: uuidOf(902),
      name: 'Status',
      type: 'singleSelect',
      options: {
        choices: [
          { id: 'selTodo', name: 'Todo', color: 'blue' },
          { id: 'selDone', name: 'Done', color: 'green' },
        ],
      },
      isPrimary: false,
    } satisfies SharedField;
    const start: SharedField = {
      id: uuidOf(903),
      name: 'Start',
      type: 'date',
      options: {},
      isPrimary: false,
    };
    const notes: SharedField = {
      id: uuidOf(904),
      name: 'Notes',
      type: 'longText',
      options: {},
      isPrimary: false,
    };
    const parentId = uuidOf(905);
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const day = (d: number) => `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(d)}`;
    const records: SharedRecord[] = [
      {
        id: uuidOf(1),
        fields: {
          [name.id]: 'Alpha',
          [status.id]: 'selDone',
          [start.id]: day(3),
          [notes.id]: 'N1',
        },
        links: { [parentId]: [] },
      },
      {
        id: uuidOf(2),
        fields: { [name.id]: 'Beta', [status.id]: 'selDone', [start.id]: day(5) },
        links: { [parentId]: [uuidOf(1)] },
      },
      {
        id: uuidOf(3),
        fields: { [name.id]: 'Gamma', [start.id]: day(20) },
        links: { [parentId]: [] },
      },
    ];
    function openLink(view: SharedView) {
      const api = stubApi(ME);
      const token = 'L'.repeat(43);
      api.shared[token] = {
        share: viewShare({
          tables: [
            { name: 'Tasks', views: [{ id: VIEW_ID, name: view.view.name, type: view.view.type }] },
          ],
        }),
        views: { [VIEW_ID]: { view, records } },
      };
      renderApp(`/s/${token}`);
      return api;
    }
    const base = { table: { name: 'Tasks' }, layout: {}, expiresAt: null };

    it('shows a kanban board read-only: stacks, counts and card fields', async () => {
      openLink({
        ...base,
        view: { name: 'Board', type: 'kanban' },
        fields: [name, notes, status],
        kanban: { stackFieldId: status.id, cardFields: [notes.id], coverFieldId: null },
      });
      const done = await screen.findByRole('region', { name: 'Done' });
      expect(within(done).getByRole('article', { name: 'Alpha' })).toBeTruthy();
      expect(within(done).getByText('N1')).toBeTruthy();
      expect(within(done).getByTestId('stack-count').textContent).toBe('2');
      const none = screen.getByRole('region', { name: 'Uncategorized' });
      expect(within(none).getByRole('article', { name: 'Gamma' })).toBeTruthy();
      expect(screen.getByRole('region', { name: 'Todo' })).toBeTruthy();
      expect(screen.getByText('3 records')).toBeTruthy();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.queryByRole('button', { name: /add|new/i })).toBeNull();
    });

    it('shows a calendar month with its events, and steps months', async () => {
      openLink({
        ...base,
        view: { name: 'Dates', type: 'calendar' },
        fields: [name, start],
        calendar: { dateFields: [{ startFieldId: start.id, endFieldId: null }] },
      });
      expect(await screen.findByText('Alpha')).toBeTruthy();
      expect(screen.getByText('Gamma')).toBeTruthy();
      const title = screen.getByRole('heading', { level: 2 }).textContent;
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      await waitFor(() =>
        expect(screen.getByRole('heading', { level: 2 }).textContent).not.toBe(title)
      );
    });

    it('shows a gallery of cards with labelled fields', async () => {
      openLink({
        ...base,
        view: { name: 'Cards', type: 'gallery' },
        fields: [name, notes],
        gallery: { cardFields: [notes.id], coverFieldId: null },
      });
      const card = await screen.findByRole('article', { name: 'Alpha' });
      expect(within(card).getByText('Notes')).toBeTruthy();
      expect(within(card).getByText('N1')).toBeTruthy();
      expect(screen.getAllByRole('article')).toHaveLength(3);
    });

    it('nests a list by its parents and collapses a branch', async () => {
      openLink({
        ...base,
        view: { name: 'Outline', type: 'list' },
        fields: [name],
        list: { parentFieldId: parentId, rowFields: [] },
      });
      const toggle = await screen.findByRole('button', { name: 'Collapse Alpha' });
      expect(screen.getByText('Beta')).toBeTruthy();
      fireEvent.click(toggle);
      expect(screen.queryByText('Beta')).toBeNull();
      expect(screen.getByRole('button', { name: 'Expand Alpha' })).toBeTruthy();
    });

    it('draws a timeline with grouped bars', async () => {
      openLink({
        ...base,
        view: { name: 'Plan', type: 'timeline' },
        fields: [name, status, start],
        timeline: { startFieldId: start.id, groupFieldId: status.id, scale: 'week' },
      });
      const list = await screen.findByRole('list', { name: 'Plan' });
      expect(await within(list).findAllByText('Alpha')).not.toHaveLength(0);
      expect(within(list).getByText('Done')).toBeTruthy();
      expect(within(list).getByText('Uncategorized')).toBeTruthy();
    });
  });

  it('says a revoked or unknown link is unavailable', async () => {
    stubApi(ME);
    renderApp(`/s/${'X'.repeat(43)}`);
    expect(await screen.findByRole('heading', { name: 'This link isn’t available' })).toBeTruthy();
  });

  it('builds links and summaries', () => {
    expect(shareUrl('abc', 'https://app.openrows.io')).toBe('https://app.openrows.io/s/abc');
    expect(expiryOf('')).toBeNull();
    expect(expiryOf('2030-02-30')).not.toBeNull();
    expect(new Date(expiryOf('2030-01-31') ?? '').getDate()).toBe(31);
    const share: Share = {
      id: 'x',
      kind: 'view',
      viewId: 'v',
      baseId: 'b',
      createdBy: null,
      createdAt: now,
      expiresAt: null,
      expired: false,
      hasPassword: false,
      allowedDomains: [],
      allowCopy: true,
      allowDownload: false,
      embedOrigins: [],
      allowRestrictedEmbed: false,
    };
    expect(shareSummary(share)).toContain('No expiry');
    expect(shareSummary({ ...share, expired: true })).toContain('Expired');
    expect(shareBadges(share)).toEqual(['Copying allowed']);
    expect(
      shareBadges({
        ...share,
        hasPassword: true,
        allowedDomains: ['example.com'],
        allowCopy: false,
        allowDownload: true,
      })
    ).toEqual(['Password', 'Only example.com', 'No copying', 'CSV download']);
    const embedded = { ...share, embedOrigins: ['https://a.example'] };
    expect(shareBadges(embedded)).toContain('Embeddable on 1 site');
    expect(shareBadges({ ...embedded, hasPassword: true })).toContain(
      'Embedding blocked (restricted link)'
    );
    expect(shareBadges({ ...embedded, hasPassword: true, allowRestrictedEmbed: true })).toContain(
      'Embeddable on 1 site'
    );
  });

  it('builds embed code and reads embed origins (#99)', () => {
    const url = embedUrl('tok', 'auto', 'https://app.openrows.io');
    expect(url).toBe('https://app.openrows.io/embed/tok?theme=auto');
    expect(embedSnippet(url, 'Q3 "Roadmap" <b>')).toBe(
      '<iframe src="https://app.openrows.io/embed/tok?theme=auto" title="Q3 &quot;Roadmap&quot; &lt;b&gt;" width="100%" height="533" style="border: 1px solid #e4e0d6; border-radius: 6px;" loading="lazy" referrerpolicy="no-referrer"></iframe>'
    );
    expect(parseEmbedOrigins('')).toEqual({ origins: [], error: null });
    expect(
      parseEmbedOrigins('https://A.example/, https://a.example\nhttps://b.example:8443')
    ).toEqual({
      origins: ['https://a.example', 'https://b.example:8443'],
      error: null,
    });
    expect(parseEmbedOrigins('a.example').error).toContain('“a.example”');
    expect(parseEmbedOrigins('https://a.example/page').error).not.toBeNull();
    const many = Array.from({ length: 21 }, (_, i) => `https://d${i}.example`).join(' ');
    expect(parseEmbedOrigins(many).error).toContain('At most 20');
  });

  it('reads allowed domains (#98)', () => {
    expect(parseDomains('')).toEqual({ domains: [], error: null });
    expect(parseDomains('Example.com, example.org\n@example.com https://acme.io/')).toEqual({
      domains: ['example.com', 'example.org', 'acme.io'],
      error: null,
    });
    expect(parseDomains('example.com, not a domain').error).toContain('“not” isn’t a domain');
    expect(parseDomains('localhost').error).not.toBeNull();
    expect(parseDomains('*.example.com').error).not.toBeNull();
  });
});

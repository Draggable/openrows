import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '../router';
import { stubApi } from '../test/fakeApi';
import { ME } from '../test/me';

function renderApp(path: string) {
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

describe('app shell', () => {
  beforeAll(() => {
    // jsdom lacks these; Radix and the theme hook use them.
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
    localStorage.clear();
  });

  it('greets a new user with an empty state, creates a first base and opens it', async () => {
    const api = stubApi(ME);
    const router = renderApp('/');

    expect(await screen.findByRole('heading', { name: 'No bases yet' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Ada');

    fireEvent.click(screen.getByRole('button', { name: 'Create a base' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Roadmap' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create base' }));

    // A workspace is created on first run, then the base with one table, then it opens.
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/b\/.+\/.+\/.+$/));
    expect(api.calls).toEqual(
      expect.arrayContaining(['POST /api/workspaces', `POST /api/bases/${api.bases[0]?.id}/tables`])
    );
    expect(api.workspaces[0]?.name).toBe("Ada's workspace");
    const tables = await screen.findByRole('navigation', { name: 'Tables' });
    expect(within(tables).getByRole('link', { name: 'Table 1' }).getAttribute('aria-current')).toBe(
      'page'
    );
    const views = screen.getByRole('navigation', { name: 'Views' });
    expect(within(views).getByRole('link', { name: 'Grid view' })).toBeTruthy();
    expect(await screen.findByRole('columnheader', { name: 'Name' })).toBeTruthy();
  });

  it('has a help menu with the docs site and the API reference', async () => {
    stubApi(ME);
    renderApp('/');
    await screen.findByRole('heading', { name: 'No bases yet' });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Help' }), {
      button: 0,
      pointerType: 'mouse',
    });
    const menu = await screen.findByRole('menu');
    const docs = within(menu).getByRole('menuitem', { name: 'Documentation' });
    expect(docs.getAttribute('href')).toBe('https://openrows.io/docs');
    expect(docs.getAttribute('target')).toBe('_blank');
    expect(docs.getAttribute('rel')).toBe('noopener noreferrer');
    expect(
      within(menu).getByRole('menuitem', { name: 'Moving from Airtable' }).getAttribute('href')
    ).toBe('https://openrows.io/docs/airtable-migration');
    expect(within(menu).getByRole('menuitem', { name: 'API reference' }).getAttribute('href')).toBe(
      '/docs/api'
    );
    // No STATUS_PAGE_URL on this instance: no status link.
    expect(within(menu).queryByRole('menuitem', { name: 'System status' })).toBeNull();
  });

  it("links the instance's status page from the help menu when the server names one", async () => {
    const api = stubApi(ME);
    api.signIn.statusPageUrl = 'https://status.example.org/';
    renderApp('/');
    await screen.findByRole('heading', { name: 'No bases yet' });
    await waitFor(() => expect(api.calls).toContain('GET /auth/providers'));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Help' }), {
      button: 0,
      pointerType: 'mouse',
    });
    const menu = await screen.findByRole('menu');
    const status = await within(menu).findByRole('menuitem', { name: 'System status' });
    expect(status.getAttribute('href')).toBe('https://status.example.org/');
    expect(status.getAttribute('target')).toBe('_blank');
    expect(status.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('redirects a base URL to its first table and view, and adds a view', async () => {
    const api = stubApi(ME);
    const router = renderApp('/');
    await screen.findByRole('heading', { name: 'No bases yet' });
    // Seed through the fake API itself.
    const ws = await (
      await fetch('/api/workspaces', { method: 'POST', body: '{"name":"W"}' })
    ).json();
    const base = await (
      await fetch(`/api/workspaces/${ws.id}/bases`, { method: 'POST', body: '{"name":"B"}' })
    ).json();
    const table = await (
      await fetch(`/api/bases/${base.id}/tables`, { method: 'POST', body: '{"name":"Tasks"}' })
    ).json();

    await router.navigate({ to: '/b/$baseId', params: { baseId: base.id } });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/b/${base.id}/${table.id}/${api.views[0]?.id}`)
    );

    const views = await screen.findByRole('navigation', { name: 'Views' });
    fireEvent.keyDown(within(views).getByRole('button', { name: 'Create view' }), { key: 'Enter' });
    const menu = await screen.findByRole('menu', { name: 'Create view' });
    // Every type can be picked.
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => [i.textContent, i.hasAttribute('data-disabled')])
    ).toEqual([
      ['Grid', false],
      ['Kanban', false],
      ['Calendar', false],
      ['Gallery', false],
      ['Timeline', false],
      ['List', false],
      ['Form', false],
    ]);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Kanban' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/b/${base.id}/${table.id}/${api.views[1]?.id}`)
    );
    expect(api.views[1]).toMatchObject({ name: 'Kanban', type: 'kanban' });
  });

  it('groups views into sections, moves them from the menu and marks personal views (#42)', async () => {
    const api = stubApi(ME);
    const router = renderApp('/');
    await screen.findByRole('heading', { name: 'No bases yet' });
    const ws = await (
      await fetch('/api/workspaces', { method: 'POST', body: '{"name":"W"}' })
    ).json();
    const base = await (
      await fetch(`/api/workspaces/${ws.id}/bases`, { method: 'POST', body: '{"name":"B"}' })
    ).json();
    await fetch(`/api/bases/${base.id}/tables`, { method: 'POST', body: '{"name":"Tasks"}' });
    await router.navigate({ to: '/b/$baseId', params: { baseId: base.id } });

    const nav = await screen.findByRole('navigation', { name: 'Views' });
    await within(nav).findByRole('link', { name: 'Grid view' });
    fireEvent.click(within(nav).getByRole('button', { name: 'New section' }));
    // The section's header (a toggle) beside the "New section" button.
    await waitFor(() =>
      expect(within(nav).getAllByRole('button', { name: 'New section' })).toHaveLength(2)
    );
    expect(api.sections[0]?.name).toBe('New section');
    const header = within(nav)
      .getAllByRole('button', { name: 'New section' })
      .find((b) => b.hasAttribute('aria-expanded'));
    expect(header?.getAttribute('aria-expanded')).toBe('true');

    // "Move to section" in the view's menu (the keyboard path beside dragging).
    fireEvent.keyDown(within(nav).getByRole('button', { name: 'Grid view options' }), {
      key: 'Enter',
    });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Lock view' })).toBeTruthy();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'New section' }));
    await waitFor(() => expect(api.views[0]?.['sectionId']).toBe(api.sections[0]?.id));

    // "Only me" in the picker keeps it open and makes the new view personal.
    fireEvent.keyDown(within(nav).getByRole('button', { name: 'Create view' }), { key: 'Enter' });
    const picker = await screen.findByRole('menu', { name: 'Create view' });
    fireEvent.click(within(picker).getByRole('menuitemcheckbox', { name: /Only me/ }));
    expect(
      within(picker)
        .getByRole('menuitemcheckbox', { name: /Only me/ })
        .getAttribute('aria-checked')
    ).toBe('true');
    fireEvent.click(within(picker).getByRole('menuitem', { name: 'Grid' }));
    // Personal views sit apart, under My views.
    const mine = await within(nav).findByRole('group', { name: 'My views' });
    expect(within(mine).getByRole('link', { name: /Grid view 2/ })).toBeTruthy();
    expect(within(mine).getByLabelText('Personal view')).toBeTruthy();
    expect(api.views[1]).toMatchObject({ name: 'Grid view 2', personal: true });
  });

  it('imports a CSV from Home into a new base and opens the import dialog on it (#80)', async () => {
    const api = stubApi(ME);
    const router = renderApp('/');
    await screen.findByRole('heading', { name: 'No bases yet' });
    expect(screen.queryByText(/coming soon/)?.textContent).toBe('Excel is coming soon');

    const csv = 'Title,Points\nWrite spec,3\nShip,5\n';
    fireEvent.change(screen.getByLabelText('CSV file for a new base'), {
      target: { files: [new File([csv], 'Launch plan.csv', { type: 'text/csv' })] },
    });

    // A base and a table named after the file; the primary field after the first column.
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/b\/.+\/.+\/.+$/));
    expect(api.bases[0]?.name).toBe('Launch plan');
    expect(api.tables[0]?.name).toBe('Launch plan');
    const dialog = await screen.findByRole('dialog', { name: 'Import CSV into Launch plan' });
    expect(await within(dialog).findByText('Launch plan.csv')).toBeTruthy();
    const fields = (api.tables[0]?.['fields'] ?? []) as { id: string; name: string }[];
    const primary = fields[0];
    expect(primary?.name).toBe('Title');
    expect(within(dialog).getByLabelText('Import column Title into')).toHaveProperty(
      'value',
      primary?.id
    );
    expect(within(dialog).getByLabelText('Import column Points into')).toHaveProperty(
      'value',
      'new'
    );
    expect(within(dialog).getByRole('button', { name: 'Import 2 records' })).toBeTruthy();
  });

  it("lists only the selected workspace's bases in the sidebar (#80)", async () => {
    stubApi(ME);
    const router = renderApp('/');
    await screen.findByRole('heading', { name: 'No bases yet' });
    const post = async (path: string, name: string) =>
      (await fetch(path, { method: 'POST', body: JSON.stringify({ name }) })).json();
    const dev = await post('/api/workspaces', "Dev's workspace");
    const demo = await post('/api/workspaces', 'Product Roadmap (demo)');
    await post(`/api/workspaces/${dev.id}/bases`, 'Scratch');
    await post(`/api/workspaces/${demo.id}/bases`, 'Product Roadmap');

    await router.navigate({ to: '/w/$workspaceId', params: { workspaceId: dev.id } });
    const sidebarBases = () => screen.getByRole('navigation', { name: 'Bases' });
    await waitFor(() =>
      expect(within(sidebarBases()).queryByRole('link', { name: 'Scratch' })).toBeTruthy()
    );
    expect(within(sidebarBases()).queryByRole('link', { name: 'Product Roadmap' })).toBeNull();

    await router.navigate({ to: '/w/$workspaceId', params: { workspaceId: demo.id } });
    await waitFor(() =>
      expect(within(sidebarBases()).queryByRole('link', { name: 'Product Roadmap' })).toBeTruthy()
    );
    expect(within(sidebarBases()).queryByRole('link', { name: 'Scratch' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Members' }).getAttribute('href')).toBe(
      `/w/${demo.id}/members`
    );

    // Home keeps the workspace last selected.
    await router.navigate({ to: '/' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Workspace: Product Roadmap (demo)' })).toBeTruthy()
    );
    expect(within(sidebarBases()).queryByRole('link', { name: 'Scratch' })).toBeNull();
  });
});

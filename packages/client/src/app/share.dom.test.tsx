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

const now = '2026-10-25T10:00:00.000Z';

/** A workspace with one base and a table, with the caller's roles. */
async function seed(
  api: ReturnType<typeof stubApi>,
  roles: { workspace: 'owner' | 'editor' | null; base: 'owner' | 'creator' | 'editor' }
) {
  const ws = { id: crypto.randomUUID(), name: 'Acme', role: roles.workspace };
  api.workspaces.push({ ...ws, createdAt: now, updatedAt: now });
  const base = {
    id: crypto.randomUUID(),
    workspaceId: ws.id,
    name: 'Roadmap',
    description: null,
    icon: null,
    color: null,
    role: roles.base,
    createdAt: now,
    updatedAt: now,
  };
  api.bases.push(base);
  await fetch(`/api/bases/${base.id}/tables`, { method: 'POST', body: '{"name":"Tasks"}' });
  return { ws, base };
}

describe('sharing a base (#91)', () => {
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
    localStorage.clear();
  });

  it('lists people with their effective roles, invites to the base and changes a role', async () => {
    const api = stubApi(ME);
    const { ws, base } = await seed(api, { workspace: 'owner', base: 'owner' });
    api.baseCollaborators.push(
      {
        id: 'a',
        baseId: base.id,
        userId: ME.user.id,
        email: ME.user.email,
        name: ME.user.name ?? 'Ada',
        avatarUrl: null,
        workspaceRole: 'owner',
        baseRole: null,
        role: 'owner',
      },
      {
        id: 'b',
        baseId: base.id,
        userId: crypto.randomUUID(),
        email: 'gina@example.test',
        name: 'Gina',
        avatarUrl: null,
        workspaceRole: null,
        baseRole: 'editor',
        role: 'editor',
      }
    );
    renderApp(`/b/${base.id}`);

    fireEvent.click(await screen.findByRole('button', { name: 'Share' }));
    const dialog = await screen.findByRole('dialog', { name: 'Share Roadmap' });
    const people = await within(dialog).findByRole('list', { name: 'People with access' });
    const rows = within(people).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('(you)'),
      expect.stringContaining('Base only'),
    ]);
    // The owner's role isn't a base role to pick.
    expect(within(rows[0] as HTMLElement).queryByRole('combobox')).toBeNull();

    const role = within(dialog).getByLabelText('Role of Gina on this base') as HTMLSelectElement;
    expect(role.value).toBe('editor');
    fireEvent.change(role, { target: { value: 'creator' } });
    await waitFor(() => expect(api.baseCollaborators[1]?.['role']).toBe('creator'));

    fireEvent.change(within(dialog).getByLabelText('Email'), {
      target: { value: 'new@example.test' },
    });
    fireEvent.change(within(dialog).getByLabelText('Role on this base'), {
      target: { value: 'commenter' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Invite' }));
    const pending = await within(dialog).findByRole('list', { name: 'Pending base invitations' });
    expect(pending.textContent).toContain('new@example.test');
    expect(api.invitations[0]).toMatchObject({ baseId: base.id, role: 'commenter' });
    // Not a workspace invitation.
    expect(
      (await (await fetch(`/api/workspaces/${ws.id}/invitations`)).json()).invitations
    ).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove from base: Gina' }));
    await waitFor(() => expect(api.baseCollaborators).toHaveLength(1));
  });

  it('hides Share from editors', async () => {
    const api = stubApi(ME);
    const { base } = await seed(api, { workspace: 'editor', base: 'editor' });
    renderApp(`/b/${base.id}`);
    await screen.findByRole('columnheader', { name: 'Name' });
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
    expect(api.calls).not.toContain(`GET /api/bases/${base.id}/collaborators`);
  });

  it('shows a base-only collaborator their shared bases, without the members page', async () => {
    const api = stubApi(ME);
    await seed(api, { workspace: null, base: 'editor' });
    renderApp('/');
    const section = await screen.findByRole('region', { name: 'Acme' });
    expect(within(section).getByText('Bases shared with you')).toBeTruthy();
    expect(within(section).getByRole('link', { name: /Roadmap/ })).toBeTruthy();
    expect(within(section).queryByRole('button', { name: 'New base' })).toBeNull();
    const main = screen.getByRole('navigation', { name: 'Main' });
    expect(within(main).queryByRole('link', { name: 'Members' })).toBeNull();
  });
});

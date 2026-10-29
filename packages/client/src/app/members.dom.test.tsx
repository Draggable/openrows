import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '../router';
import { stubApi } from '../test/fakeApi';
import { ME } from '../test/me';

const NOW = '2026-10-25T10:00:00.000Z';
const TOKEN = 'a'.repeat(43);

function renderApp(path: string) {
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

/** A workspace where Ada is owner, with Bob as an editor. */
function seed(role: 'owner' | 'editor' = 'owner') {
  const api = stubApi(ME);
  const ws = { id: crypto.randomUUID(), name: 'Acme', role, createdAt: NOW, updatedAt: NOW };
  api.workspaces.push(ws);
  const member = (userId: string, name: string, email: string, r: string) => ({
    workspaceId: ws.id,
    id: userId,
    userId,
    name,
    email,
    avatarUrl: null,
    role: r,
    joinedAt: NOW,
  });
  api.members.push(member(ME.user.id, 'Ada Lovelace', 'ada@example.test', role));
  api.members.push(member(crypto.randomUUID(), 'Bob Builder', 'bob@example.test', 'editor'));
  return { api, ws };
}

describe('workspaces, members and invitations (#16)', () => {
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
  afterEach(() => vi.unstubAllGlobals());

  it('lists members, invites by email, changes a role and removes a member', async () => {
    const { api, ws } = seed();
    renderApp(`/w/${ws.id}/members`);

    const list = await screen.findByRole('list', { name: 'Members' });
    expect(within(list).getByText('Bob Builder')).toBeTruthy();
    expect(within(list).getByText('(you)')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'Carol@Example.test' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'creator' } });
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    const pending = await screen.findByRole('list', { name: 'Pending invitations' });
    expect(within(pending).getByText('carol@example.test')).toBeTruthy();
    expect(api.invitations[0]).toMatchObject({ email: 'carol@example.test', role: 'creator' });

    fireEvent.change(screen.getByLabelText('Role of Bob Builder'), {
      target: { value: 'commenter' },
    });
    await waitFor(() => expect(api.members[1]?.['role']).toBe('commenter'));

    fireEvent.click(screen.getByRole('button', { name: 'Remove Bob Builder' }));
    await waitFor(() => expect(screen.queryByText('Bob Builder')).toBeNull());

    fireEvent.click(
      screen.getByRole('button', { name: 'Revoke the invitation for carol@example.test' })
    );
    expect(await screen.findByText('No pending invitations.')).toBeTruthy();
  });

  it('shows roles read-only to members who cannot manage them', async () => {
    const { api, ws } = seed('editor');
    renderApp(`/w/${ws.id}/members`);
    const list = await screen.findByRole('list', { name: 'Members' });
    expect(within(list).getAllByText('Editor')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull();
    expect(screen.queryByLabelText('Role of Bob Builder')).toBeNull();
    expect(api.calls).not.toContain(`GET /api/workspaces/${ws.id}/invitations`);
  });

  it('switches workspaces and opens members from the switcher', async () => {
    const { api, ws } = seed();
    api.workspaces.push({
      id: crypto.randomUUID(),
      name: 'Side project',
      role: 'owner',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const router = renderApp('/');
    const trigger = await screen.findByRole('button', { name: 'Workspace: Acme' });
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Side project' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${api.workspaces[1]?.id}`));
    expect(await screen.findByRole('button', { name: 'Workspace: Side project' })).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Workspace: Side project' }), {
      button: 0,
      pointerType: 'mouse',
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Members' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/w/${api.workspaces[1]?.id}/members`)
    );
    expect(ws.id).not.toBe(api.workspaces[1]?.id);
  });

  it('accepts an invitation from the emailed link and opens the workspace', async () => {
    const api = stubApi(ME);
    const workspaceId = crypto.randomUUID();
    api.previews[TOKEN] = {
      workspaceId,
      workspaceName: 'Acme',
      baseId: null,
      baseName: null,
      interfaceId: null,
      interfaceName: null,
      inviterName: 'Grace',
      email: 'ada@example.test',
      role: 'editor',
      expiresAt: '2026-11-01T10:00:00.000Z',
      status: 'pending',
      emailMatches: true,
      alreadyMember: false,
    };
    const router = renderApp(`/invite/${TOKEN}`);
    expect(await screen.findByRole('heading', { name: 'Join Acme' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${workspaceId}`));
    expect(api.calls).toContain(`POST /api/invitations/${TOKEN}/accept`);
  });

  it('explains an invitation for another address, and an unknown link', async () => {
    const api = stubApi(ME);
    api.previews[TOKEN] = {
      workspaceId: crypto.randomUUID(),
      workspaceName: 'Acme',
      baseId: null,
      baseName: null,
      interfaceId: null,
      interfaceName: null,
      inviterName: null,
      email: 'bob@example.test',
      role: 'editor',
      expiresAt: '2026-11-01T10:00:00.000Z',
      status: 'pending',
      emailMatches: false,
      alreadyMember: false,
    };
    renderApp(`/invite/${TOKEN}`);
    expect(await screen.findByText(/Sign in with bob@example.test to accept it/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).toBeNull();
  });

  it('says when a link is not valid', async () => {
    stubApi(ME);
    renderApp(`/invite/${'b'.repeat(43)}`);
    expect(
      await screen.findByRole('heading', { name: 'This invitation link is not valid' })
    ).toBeTruthy();
  });
});

import type { Notification } from '@openrows/shared';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '../../router';
import { stubApi } from '../../test/fakeApi';
import { ME } from '../../test/me';

function renderApp(path: string) {
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

function notification(over: Partial<Notification>): Notification {
  return {
    id: crypto.randomUUID(),
    kind: 'mention',
    actorId: crypto.randomUUID(),
    actorName: 'Grace',
    workspaceId: crypto.randomUUID(),
    baseId: crypto.randomUUID(),
    tableId: crypto.randomUUID(),
    recordId: crypto.randomUUID(),
    commentId: crypto.randomUUID(),
    fieldId: null,
    baseName: 'Roadmap',
    tableName: 'Features',
    recordName: 'Kanban view',
    fieldName: null,
    excerpt: 'Can you look at @Ada this?',
    createdAt: new Date().toISOString(),
    readAt: null,
    ...over,
  };
}

describe('notification bell (#93)', () => {
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

  it('shows the unread count, lists the inbox, marks all read', async () => {
    const api = stubApi(ME);
    api.notifications.push(
      notification({}),
      notification({
        kind: 'assigned',
        commentId: null,
        excerpt: null,
        fieldId: crypto.randomUUID(),
        fieldName: 'Owner',
        recordName: '',
      }),
      notification({ kind: 'reply', excerpt: 'Done', readAt: new Date().toISOString() })
    );
    renderApp('/');
    const bell = await screen.findByRole('button', { name: 'Notifications, 2 unread' });
    expect(within(bell).getByTestId('notification-count').textContent).toBe('2');
    fireEvent.click(bell);
    const inbox = await screen.findByRole('region', { name: 'Notifications' });
    expect(await within(inbox).findByText('Grace mentioned you on Kanban view')).toBeTruthy();
    expect(within(inbox).getByText('Can you look at @Ada this?')).toBeTruthy();
    expect(within(inbox).getByText('Grace added you to Owner on Unnamed record')).toBeTruthy();
    expect(within(inbox).getByText('Grace replied on Kanban view')).toBeTruthy();
    expect(within(inbox).getAllByText('(unread)')).toHaveLength(2);

    fireEvent.click(within(inbox).getByRole('button', { name: 'Mark all as read' }));
    await screen.findByRole('button', { name: 'Notifications' });
    expect(api.calls).toContain('POST /api/notifications/read');
    expect(screen.queryByTestId('notification-count')).toBeNull();
  });

  it('opens a notification: marks it read and deep-links to the record and comment', async () => {
    const api = stubApi(ME);
    // Seeded through the fake API before the app renders.
    const ws = await (
      await fetch('/api/workspaces', { method: 'POST', body: '{"name":"W"}' })
    ).json();
    const base = await (
      await fetch(`/api/workspaces/${ws.id}/bases`, { method: 'POST', body: '{"name":"B"}' })
    ).json();
    const table = await (
      await fetch(`/api/bases/${base.id}/tables`, { method: 'POST', body: '{"name":"Tasks"}' })
    ).json();
    const n = notification({ baseId: base.id, tableId: table.id });
    api.notifications.push(n);
    const router = renderApp('/');
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    fireEvent.click(await screen.findByText('Grace mentioned you on Kanban view'));
    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(
        new RegExp(`^/b/${base.id}/${table.id}/[0-9a-f-]+$`)
      )
    );
    expect(router.state.location.search).toEqual({ record: n.recordId, comment: n.commentId });
    expect(api.calls).toContain(`POST /api/notifications/${n.id}/read`);
  });
});

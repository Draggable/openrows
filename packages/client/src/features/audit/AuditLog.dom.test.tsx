import type { AuditEvent } from '@openrows/shared';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '../../router';
import { stubApi } from '../../test/fakeApi';
import { ME } from '../../test/me';

const NOW = '2026-10-25T10:00:00.000Z';

function renderApp(path: string) {
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

const event = (over: Partial<AuditEvent>): AuditEvent => ({
  id: crypto.randomUUID(),
  at: NOW,
  action: 'workspace.update',
  actor: { kind: 'user', userId: crypto.randomUUID(), email: 'ada@example.test' },
  ip: '203.0.113.9',
  userAgent: 'Firefox',
  target: { type: 'workspace', id: null, name: 'Acme' },
  summary: {},
  ...over,
});

describe('the workspace audit log page (#157)', () => {
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

  function seed(role = 'owner') {
    const api = stubApi(ME);
    const ws = { id: crypto.randomUUID(), name: 'Acme', role, createdAt: NOW, updatedAt: NOW };
    api.workspaces.push(ws);
    return { api, ws };
  }

  it('lists entries with who, what, details and IP, filters by activity, and exports', async () => {
    const { api, ws } = seed();
    api.audit[ws.id] = {
      events: [
        event({
          action: 'member.role_change',
          target: { type: 'user', id: null, name: 'bob@example.test' },
          summary: { before: { role: 'editor' }, after: { role: 'creator' } },
        }),
        event({
          actor: { kind: 'admin', userId: null, email: 'staff@openrows.io' },
          action: 'impersonation.start',
        }),
        event({ summary: { before: { name: 'Old' }, after: { name: 'Acme' } } }),
      ],
      stream: null,
    };
    renderApp(`/w/${ws.id}/audit-log`);
    const table = await screen.findByRole('table', { name: 'Audit log, newest first' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain("Changed a member's role");
    expect(rows[0]?.textContent).toContain('role: editor → creator');
    expect(rows[0]?.textContent).toContain('203.0.113.9');
    expect(rows[1]?.textContent).toContain('OpenRows support (staff@openrows.io)');
    expect(screen.getByText('Entries are kept for 365 days.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Activity'), { target: { value: 'member' } });
    await vi.waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Audit log, newest first' })).getAllByRole('row')
      ).toHaveLength(2)
    );
    expect(api.calls).toContain(`GET /api/workspaces/${ws.id}/audit-log`);
    const csv = screen.getByRole('link', { name: 'Export CSV' }).getAttribute('href') ?? '';
    expect(csv).toContain(`/api/workspaces/${ws.id}/audit-log/export?`);
    expect(csv).toContain('action=member');
    expect(csv).toContain('format=csv');
  });

  it('sets up the SIEM stream and shows its secret once', async () => {
    const { api, ws } = seed();
    api.audit[ws.id] = { events: [], stream: null };
    renderApp(`/w/${ws.id}/audit-log`);
    expect(await screen.findByText('Nothing matches these filters yet.')).toBeTruthy();
    fireEvent.change(await screen.findByLabelText('Endpoint URL'), {
      target: { value: 'https://siem.example.test/ingest' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start streaming' }));
    expect((await screen.findByTestId('audit-stream-secret')).textContent).toBe(
      'whsec_fake-secret'
    );
    expect(screen.getByTestId('audit-stream-state').textContent).toBe('On. Nothing sent yet.');
  });

  it('explains the plan and the edition when there is no log to show', async () => {
    const plan = seed();
    plan.api.audit[plan.ws.id] = { events: [], stream: null, refuse: 'plan' };
    renderApp(`/w/${plan.ws.id}/audit-log`);
    expect(await screen.findByText(/part of the Enterprise plan/)).toBeTruthy();
  });

  it('says a self-hosted server keeps none, and keeps it to owners', async () => {
    const { ws } = seed();
    renderApp(`/w/${ws.id}/audit-log`);
    expect(await screen.findByText("This OpenRows server doesn't keep an audit log.")).toBeTruthy();
  });

  it('keeps it to owners', async () => {
    const { ws } = seed('creator');
    renderApp(`/w/${ws.id}/audit-log`);
    expect(await screen.findByText("Only the workspace's owners see its audit log.")).toBeTruthy();
  });
});

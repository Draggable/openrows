import type { Automation, AutomationRun, AutomationScripts } from '@openrows/shared';
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

const now = '2026-10-27T10:00:00.000Z';

/**
 * The automations API on top of the shell's fake: list, create, change, test, runs and retry.
 * Saving a step that sets "Name" to "bad" answers the server's 422 for that cell.
 */
async function setUp(
  scripts: AutomationScripts = { available: false, reason: 'disabled', limits: null }
) {
  const api = stubApi(ME);
  const ws = await (
    await fetch('/api/workspaces', { method: 'POST', body: '{"name":"Acme"}' })
  ).json();
  const base = await (
    await fetch(`/api/workspaces/${ws.id}/bases`, { method: 'POST', body: '{"name":"CRM"}' })
  ).json();
  const table = await (
    await fetch(`/api/bases/${base.id}/tables`, { method: 'POST', body: '{"name":"Tasks"}' })
  ).json();
  const nameField = table.fields[0];
  const recordId = crypto.randomUUID();
  const automations: (Automation & { runCount: number })[] = [];
  const runs: AutomationRun[] = [];
  const requests: { method: string; path: string; body: unknown }[] = [];
  const inner = api.fetch.getMockImplementation();
  if (!inner) throw new Error('no fake fetch');
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  const run = (over: Partial<AutomationRun>): AutomationRun => ({
    id: crypto.randomUUID(),
    automationId: automations[0]?.id ?? '',
    status: 'succeeded',
    mode: 'live',
    skipReason: null,
    retryOf: null,
    trigger: { type: 'recordCreated', record: { id: recordId, fields: { Name: 'Ship it' } } },
    steps: [],
    error: null,
    depth: 1,
    triggeredBy: null,
    durationMs: 4,
    createdAt: now,
    ...over,
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname;
    const prefix = `/api/bases/${base.id}/automations`;
    if (path.startsWith(prefix)) requests.push({ method, path, body });
    if (path === prefix && method === 'GET') return json({ automations, scripts });
    if (path === `/api/bases/${base.id}/automation-runs/failed`) {
      requests.push({ method, path, body });
      const dead = runs.filter(
        (r) => r.status === 'failed' && r.mode !== 'test' && !runs.some((x) => x.retryOf === r.id)
      );
      return json({
        runs: dead.map((r) => ({
          ...r,
          automationName: automations.find((x) => x.id === r.automationId)?.name ?? '',
        })),
      });
    }
    if (path === prefix && method === 'POST') {
      const a = {
        id: crypto.randomUUID(),
        baseId: base.id,
        description: '',
        enabled: false,
        disabledReason: null,
        actions: [],
        createdBy: ME.user.id,
        lastRunAt: null,
        lastRunStatus: null,
        nextRunAt: null,
        webhookUrl: null,
        webhookSample: null,
        createdAt: now,
        updatedAt: now,
        runCount: 0,
        ...body,
      };
      automations.push(a);
      return json(a, 201);
    }
    const one = path.match(/\/automations\/([^/]+)(\/.*)?$/);
    const a = automations.find((x) => x.id === one?.[1]);
    if (a && !one?.[2] && method === 'PATCH') {
      const cells = body.actions?.[0]?.fields ?? {};
      if (cells[nameField.id] === 'bad') {
        return json(
          {
            title: 'VALIDATION_FAILED',
            status: 422,
            code: 'VALIDATION_FAILED',
            detail: 'The automation is invalid.',
            errors: [{ path: `actions.0.fields.${nameField.id}`, message: 'Not a good name.' }],
          },
          422
        );
      }
      Object.assign(a, body);
      return json(a);
    }
    if (a && one?.[2] === '/test' && method === 'POST') {
      const r = run({
        mode: 'test',
        steps: [
          {
            index: 1,
            type: 'createRecord',
            status: 'succeeded',
            input: { fields: { Name: 'Copy of Ship it' } },
            output: { id: crypto.randomUUID() },
            error: null,
            durationMs: 3,
          },
        ],
      });
      runs.unshift(r);
      return json(r);
    }
    if (a && one?.[2] === '/runs') {
      const status = url.searchParams.get('status');
      return json({ runs: runs.filter((r) => !status || r.status === status) });
    }
    const retry = one?.[2]?.match(/^\/runs\/([^/]+)\/retry$/);
    if (a && retry && method === 'POST') {
      const r = run({ mode: 'retry', retryOf: retry[1] ?? null });
      runs.unshift(r);
      return json(r);
    }
    if (path === `/api/tables/${table.id}/records`) {
      return json({
        records: [
          {
            id: recordId,
            tableId: table.id,
            version: 1,
            fields: { [nameField.id]: 'Ship it' },
            createdAt: now,
            createdBy: null,
            updatedAt: now,
            updatedBy: null,
          },
        ],
        nextCursor: null,
      });
    }
    return inner(input, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { base, table, nameField, automations, runs, requests, run };
}

describe('automations builder (#111)', () => {
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
    Element.prototype.scrollIntoView ??= () => {};
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('builds an automation: trigger, an action with a token, inline errors, save and test', async () => {
    const { base, table, nameField, requests } = await setUp();
    renderApp(`/b/${base.id}/automations`);
    expect(await screen.findByText('No automations yet')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'New automation' })[0] as HTMLElement);
    const when = await screen.findByRole('region', { name: 'When a record is created' });
    expect(within(when).getByLabelText('Table')).toHaveProperty('value', table.id);
    expect(requests.find((r) => r.method === 'POST')?.body).toMatchObject({
      name: 'Automation 1',
      trigger: { type: 'recordCreated', tableId: table.id },
    });

    // An action, a field, and a token from the picker.
    fireEvent.change(screen.getByLabelText('Add an action'), { target: { value: 'createRecord' } });
    const step = await screen.findByRole('region', { name: 'Create record' });
    fireEvent.change(await within(step).findByLabelText('Add a field to step 1'), {
      target: { value: nameField.id },
    });
    fireEvent.click(
      within(step).getByRole('button', { name: 'Insert a value into Name in step 1' })
    );
    fireEvent.click(await screen.findByRole('option', { name: 'Record › Name' }));
    const input = within(step).getByLabelText('Name') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('{{trigger.record.fields.Name}}'));

    // The server's 422 shows on the cell's input.
    fireEvent.change(input, { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await within(step).findByText('Not a good name.')).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(input, { target: { value: 'Copy of {{trigger.record.fields.Name}}' } });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await screen.findByText('Automation saved');
    const patch = requests.filter((r) => r.method === 'PATCH').at(-1);
    expect(patch?.body).toEqual({
      actions: [
        {
          type: 'createRecord',
          tableId: table.id,
          fields: { [nameField.id]: 'Copy of {{trigger.record.fields.Name}}' },
        },
      ],
    });
    await waitFor(() => expect(within(step).queryByText('Not a good name.')).toBeNull());

    // Test with a sample record: a warning first, then each step's result.
    const panel = screen.getByRole('complementary', { name: 'Test and run history' });
    expect(within(panel).getByRole('note').textContent).toContain('for real');
    await within(panel).findByRole('option', { name: 'Ship it' });
    fireEvent.change(within(panel).getByLabelText('Test with record'), {
      target: { value: await recordOf(table.id) },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Run test' }));
    const result = await within(panel).findByRole('region', { name: 'Test result' });
    expect(result.textContent).toContain('Test succeeded');
    expect(result.textContent).toContain('Step 1: Create record');
    expect(result.textContent).toContain('Copy of Ship it');
    expect(requests.find((r) => r.path.endsWith('/test'))?.body).toEqual({
      recordId: await recordOf(table.id),
    });
  });

  it('adds a run-script step with input variables when scripts are available (#112)', async () => {
    const { base, table, requests } = await setUp({
      available: true,
      reason: null,
      limits: { timeoutSeconds: 30, cpuSeconds: 10, memoryMb: 128 },
    });
    renderApp(`/b/${base.id}/automations`);
    fireEvent.click(
      (await screen.findAllByRole('button', { name: 'New automation' }))[0] as HTMLElement
    );
    await screen.findByRole('region', { name: 'When a record is created' });
    fireEvent.change(screen.getByLabelText('Add an action'), { target: { value: 'runScript' } });
    const step = await screen.findByRole('region', { name: 'Run a script' });
    expect(within(step).getByRole('note').textContent).toContain('128 MB');
    const script = within(step).getByLabelText('Script (JavaScript)') as HTMLTextAreaElement;
    expect(script.value).toContain("base.getTable('Tasks')");
    expect((within(step).getByLabelText('Input 1 value') as HTMLInputElement).value).toBe(
      '{{trigger.record.id}}'
    );
    fireEvent.click(within(step).getByRole('button', { name: 'Add input' }));
    fireEvent.change(within(step).getByLabelText('Input 2 name'), { target: { value: 'who' } });
    fireEvent.change(within(step).getByLabelText('Input 2 value'), { target: { value: 'Ada' } });
    fireEvent.change(script, { target: { value: "output.set('total', 1);" } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Automation saved');
    expect(requests.filter((r) => r.method === 'PATCH').at(-1)?.body).toEqual({
      actions: [
        {
          type: 'runScript',
          script: "output.set('total', 1);",
          inputs: { recordId: '{{trigger.record.id}}', who: 'Ada' },
        },
      ],
    });
    expect(table.id).toBeTruthy();
  });

  it("offers no run-script step where the server doesn't run scripts", async () => {
    const { base } = await setUp();
    renderApp(`/b/${base.id}/automations`);
    fireEvent.click(
      (await screen.findAllByRole('button', { name: 'New automation' }))[0] as HTMLElement
    );
    await screen.findByRole('region', { name: 'When a record is created' });
    const option = screen.getByRole('option', {
      name: 'Run a script (not available)',
    }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });

  it('reorders and deletes steps with the keyboard-reachable buttons', async () => {
    const { base, table, automations } = await setUp();
    automations.push({
      id: crypto.randomUUID(),
      baseId: base.id,
      name: 'Steps',
      description: '',
      enabled: false,
      disabledReason: null,
      trigger: { type: 'recordCreated', tableId: table.id },
      actions: [
        { type: 'sendEmail', to: ['a@example.com'], subject: 'One', body: '' },
        { type: 'slackMessage', text: 'Two' },
      ],
      createdBy: ME.user.id,
      lastRunAt: null,
      lastRunStatus: null,
      nextRunAt: null,
      webhookUrl: null,
      webhookSample: null,
      createdAt: now,
      updatedAt: now,
      runCount: 0,
    });
    renderApp(`/b/${base.id}/automations?a=${automations[0]?.id}`);
    const list = await screen.findByRole('list', { name: 'Actions' });
    const titles = () =>
      within(list)
        .getAllByRole('heading')
        .map((h) => h.textContent);
    expect(titles()).toEqual(['Send email', 'Send Slack message']);
    fireEvent.click(screen.getByRole('button', { name: 'Move step 2 up' }));
    expect(titles()).toEqual(['Send Slack message', 'Send email']);
    expect(
      (screen.getByRole('button', { name: 'Move step 1 up' }) as HTMLButtonElement).disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete step 1' }));
    expect(titles()).toEqual(['Send email']);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
      false
    );
    // Turning it on or off waits for the save.
    expect((screen.getByRole('switch', { name: 'Steps on' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('lists automations with their switch, last run and runs; history filters and retries', async () => {
    const { base, table, automations, runs, requests, run } = await setUp();
    automations.push({
      id: crypto.randomUUID(),
      baseId: base.id,
      name: 'Loop',
      description: '',
      enabled: true,
      disabledReason: null,
      trigger: { type: 'recordUpdated', tableId: table.id, fieldIds: null },
      actions: [{ type: 'slackMessage', text: 'Hi' }],
      createdBy: ME.user.id,
      lastRunAt: now,
      lastRunStatus: 'skipped',
      nextRunAt: null,
      webhookUrl: null,
      webhookSample: null,
      createdAt: now,
      updatedAt: now,
      runCount: 2,
    });
    runs.push(
      run({
        status: 'skipped',
        skipReason: 'loop',
        depth: 4,
        error: 'Stopped: automations triggered each other 3 levels deep (loop guard).',
      }),
      run({
        status: 'skipped',
        skipReason: 'quota',
        error: "Skipped: this workspace's plan allows 100 automation runs per month.",
      }),
      run({ status: 'failed', error: 'Step 1 failed: Slack answered 500.' })
    );
    renderApp(`/b/${base.id}/automations`);
    const row = (await screen.findByRole('link', { name: 'Loop' })).closest('tr') as HTMLElement;
    expect(within(row).getByRole('switch', { name: 'Loop on' }).getAttribute('aria-checked')).toBe(
      'true'
    );
    expect(row.textContent).toContain('Skipped');
    expect(row.textContent).toContain('2');
    fireEvent.click(within(row).getByRole('switch', { name: 'Loop on' }));
    await waitFor(() =>
      expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({ enabled: false })
    );

    fireEvent.click(within(row).getByRole('link', { name: 'Loop' }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Run history' }));
    const history = await screen.findByRole('list', { name: 'Runs' });
    expect(history.textContent).toContain('loop guard');
    // A run past the plan's monthly runs is in the history, tagged.
    expect(history.textContent).toContain('Plan limit');
    expect(history.textContent).toContain('100 automation runs per month');
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'failed' } });
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Runs' })).getAllByRole('listitem')
      ).toHaveLength(1)
    );
    const failed = within(screen.getByRole('list', { name: 'Runs' })).getByRole('listitem');
    fireEvent.click(within(failed).getByText('Ship it'));
    fireEvent.click(within(failed).getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(requests.some((r) => r.method === 'POST' && r.path.endsWith('/retry'))).toBe(true)
    );
  });

  it('lists failed runs of every automation and retries one from the list (#126)', async () => {
    const { base, table, automations, runs, requests, run } = await setUp();
    const id = crypto.randomUUID();
    automations.push({
      id,
      baseId: base.id,
      name: 'Notify',
      description: '',
      enabled: true,
      disabledReason: null,
      trigger: { type: 'recordCreated', tableId: table.id },
      actions: [{ type: 'slackMessage', text: 'Hi' }],
      createdBy: ME.user.id,
      lastRunAt: now,
      lastRunStatus: 'failed',
      nextRunAt: null,
      webhookUrl: null,
      webhookSample: null,
      createdAt: now,
      updatedAt: now,
      runCount: 1,
    });
    runs.push(
      run({ automationId: id, status: 'failed', error: 'Step 1 failed: Slack answered 500.' })
    );
    renderApp(`/b/${base.id}/automations`);
    const list = await screen.findByRole('list', { name: 'Failed runs' });
    expect(screen.getByRole('heading', { name: 'Failed runs (1)' })).toBeTruthy();
    const item = within(list).getByRole('listitem');
    expect(item.textContent).toContain('Notify');
    expect(item.textContent).toContain('Slack answered 500');
    fireEvent.click(within(item).getByText('Notify'));
    fireEvent.click(within(item).getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(
        requests.some(
          (r) =>
            r.method === 'POST' &&
            r.path === `/api/bases/${base.id}/automations/${id}/runs/${runs.at(-1)?.id}/retry`
        )
      ).toBe(true)
    );
    // Retried: it leaves the list.
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Failed runs' })).toBeNull());
  });
});

async function recordOf(tableId: string): Promise<string> {
  const res = await fetch(`/api/tables/${tableId}/records`);
  const { records } = (await res.json()) as { records: { id: string }[] };
  return records[0]?.id ?? '';
}

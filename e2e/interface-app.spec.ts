import AxeBuilder from '@axe-core/playwright';
import type { Page, Route } from '@playwright/test';
import { mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// An interface on its own (/i/:interfaceId) against a mocked API: what an interface-only
// collaborator uses. Its published pages read and write through the interface's routes only: a
// form page submits a new record, a kanban page shows its stacks, and a record review page edits
// the field it makes editable. The access rules themselves are in the server's integration tests
// (interface-only.test.ts and the authz matrix); e2e/interfaces-shared.spec.ts runs this on the
// whole stack, with an invitation.

const uuid = (n: number) => `0190f000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const IFACE = uuid(1);
const BASE = uuid(2);
const TABLE = uuid(3);
const F = { title: uuid(10), stage: uuid(11), notes: uuid(12) };
const PAGES = { form: uuid(20), board: uuid(21), review: uuid(22) };

const stage = {
  id: F.stage,
  name: 'Stage',
  type: 'singleSelect',
  isPrimary: false,
  options: {
    choices: [
      { id: 'open', name: 'Open', color: 'green' },
      { id: 'done', name: 'Done', color: 'blue' },
    ],
  },
};
const title = { id: F.title, name: 'Title', type: 'singleLineText', isPrimary: true, options: {} };
const notes = { id: F.notes, name: 'Notes', type: 'singleLineText', isPrimary: false, options: {} };
const base = { layout: 'recordList', tableId: TABLE, sorts: [], fields: [], elements: [] };
const configs = {
  [PAGES.form]: {
    ...base,
    layout: 'form',
    form: {
      fields: [
        { fieldId: F.title, label: 'Subject', required: true },
        { fieldId: F.notes, label: '', required: false },
      ],
      submitLabel: 'Send request',
      successMessage: 'Got it, thanks.',
    },
  },
  [PAGES.board]: { ...base, layout: 'kanban', kanban: { stackFieldId: F.stage } },
  [PAGES.review]: {
    ...base,
    layout: 'recordReview',
    fields: [F.stage],
    elements: [
      { id: 'n', type: 'field', x: 0, y: 0, w: 6, h: 2, fieldId: F.notes, editable: true },
    ],
  },
};
const page_ = (id: string, name: string, position: number) => ({
  id,
  interfaceId: IFACE,
  name,
  position,
  draft: null,
  published: configs[id],
  publishedAt: '2026-10-28T10:00:00.000Z',
  hasChanges: false,
});
const records = [
  { id: uuid(30), fields: { [F.title]: 'Printer jammed', [F.stage]: 'open', [F.notes]: '' } },
  { id: uuid(31), fields: { [F.title]: 'VPN down', [F.stage]: 'done', [F.notes]: 'Fixed' } },
];

async function mockInterface(page: Page) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  const json = (route: Route, data: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  await page.route('**/api/interfaces/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const body = req.postData() ? JSON.parse(req.postData() ?? '{}') : undefined;
    if (path === `/api/interfaces/${IFACE}` && req.method() === 'GET') {
      return json(route, {
        interface: {
          id: IFACE,
          baseId: BASE,
          name: 'Help desk',
          position: 1,
          pages: [
            page_(PAGES.form, 'New request', 1),
            page_(PAGES.board, 'Board', 2),
            page_(PAGES.review, 'Review', 3),
          ],
        },
        baseName: 'Support',
        workspaceId: uuid(4),
        canEdit: false,
        access: 'interface',
        role: 'editor',
      });
    }
    const m = path.match(/\/pages\/([^/]+)\/(records|submissions)(?:\/([^/]+))?$/);
    const pageId = m?.[1] ?? '';
    if (m?.[2] === 'records' && req.method() === 'POST') {
      const layout = configs[pageId]?.layout;
      return json(route, {
        table: { id: TABLE, name: 'Requests' },
        fields:
          layout === 'form'
            ? [title, notes]
            : layout === 'kanban'
              ? [title, stage]
              : [title, stage, notes],
        records: layout === 'form' ? [] : records,
        offset: 0,
        total: layout === 'form' ? 0 : records.length,
        editable: layout === 'recordReview' ? [F.notes] : [],
        canSubmit: layout === 'form',
        ...(layout === 'kanban' ? { kanban: { stackFieldId: F.stage, cardFields: [] } } : {}),
      });
    }
    writes.push({ method: req.method(), path, body });
    if (m?.[2] === 'submissions') return json(route, { id: uuid(40) }, 201);
    return route.fulfill({ status: 204 });
  });
  return writes;
}

async function seriousViolations(page: Page) {
  const axe = await new AxeBuilder({ page })
    .include('main')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  return axe.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
}

test('an interface-only collaborator submits a form, sees a board and edits a record', async ({
  page,
}) => {
  await mockApi(page, { rows: 3 });
  const writes = await mockInterface(page);
  await page.goto(`/i/${IFACE}`);

  await expect(page.getByRole('heading', { name: 'New request', level: 1 })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Pages' });
  await expect(nav.getByRole('link')).toHaveText(['New request', 'Board', 'Review']);
  // No way into the base from here.
  await expect(page.getByRole('link', { name: 'Open in the base' })).toHaveCount(0);

  // The form: the required field first, then the submission through the page.
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByText('Required', { exact: true })).toBeVisible();
  expect(writes).toEqual([]);
  await page.getByLabel('Subject').fill('Monitor flickers');
  await page.getByLabel('Notes').fill('Since Monday');
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByText('Got it, thanks.')).toBeVisible();
  expect(writes).toEqual([
    {
      method: 'POST',
      path: `/api/interfaces/${IFACE}/pages/${PAGES.form}/submissions`,
      body: { fields: { [F.title]: 'Monitor flickers', [F.notes]: 'Since Monday' } },
    },
  ]);
  expect(await seriousViolations(page)).toEqual([]);

  // The board: the records in their stacks, read-only.
  await nav.getByRole('link', { name: 'Board' }).click();
  await expect(page.getByRole('heading', { name: 'Board', level: 1 })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Printer jammed' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'VPN down' })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
  // Overflowing, the board and its stacks scroll by keyboard (axe's scrollable-region-focusable).
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 800, height: 260 });
  await expect(page.getByRole('region', { name: 'Board', exact: true })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
  if (viewport) await page.setViewportSize(viewport);

  // The review page: the editable field saves through the page's record route.
  await nav.getByRole('link', { name: 'Review' }).click();
  await expect(page.getByRole('heading', { name: 'Printer jammed' })).toBeVisible();
  const field = page.getByRole('textbox', { name: 'Notes' });
  await field.fill('Paper tray stuck');
  await field.blur();
  await expect
    .poll(() => writes.at(-1))
    .toEqual({
      method: 'PATCH',
      path: `/api/interfaces/${IFACE}/pages/${PAGES.review}/records/${records[0]?.id}`,
      body: { fields: { [F.notes]: 'Paper tray stuck' } },
    });
  expect(await seriousViolations(page)).toEqual([]);
});

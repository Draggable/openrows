import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './helpers/test.js';

// Members and invitations in the browser against a mocked API (page.route), like
// grid.spec.ts: the members page with an invite, and accepting an emailed invitation link.
// The real invite → accept flow is covered against Postgres in
// packages/server/test/integration/members.test.ts.

const now = '2026-10-25T10:00:00.000Z';
const WS = '00000001-0000-4000-8000-000000000001';
const ADA = '00000002-0000-4000-8000-000000000001';
const BOB = '00000002-0000-4000-8000-000000000002';
const TOKEN = 'a'.repeat(43);

async function mock(page: Page, opts: { member: boolean }) {
  const workspaces = opts.member
    ? [{ id: WS, name: 'Acme', role: 'owner', createdAt: now, updatedAt: now }]
    : [];
  const members = [
    {
      userId: ADA,
      email: 'ada@example.test',
      name: 'Ada Lovelace',
      avatarUrl: null,
      role: 'owner',
      joinedAt: now,
    },
    {
      userId: BOB,
      email: 'bob@example.test',
      name: 'Bob Builder',
      avatarUrl: null,
      role: 'editor',
      joinedAt: now,
    },
  ];
  const invitations: Record<string, unknown>[] = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/me') {
      return json({
        user: {
          id: ADA,
          email: 'ada@example.test',
          name: 'Ada Lovelace',
          avatarUrl: null,
          isSystemAdmin: false,
        },
        session: { createdAt: now, expiresAt: '2026-11-24T10:00:00.000Z' },
      });
    }
    if (path === '/api/workspaces') return json({ workspaces });
    if (path === `/api/workspaces/${WS}`) return json(workspaces[0]);
    if (path === `/api/workspaces/${WS}/bases`) return json({ bases: [] });
    if (path === `/api/workspaces/${WS}/members`) return json({ members });
    if (path === `/api/workspaces/${WS}/invitations`) {
      if (method === 'POST') {
        const body = req.postDataJSON() as { email: string; role: string };
        const inv = {
          id: '00000003-0000-4000-8000-000000000001',
          workspaceId: WS,
          baseId: null,
          email: body.email.toLowerCase(),
          role: body.role,
          invitedByName: 'Ada Lovelace',
          expiresAt: '2026-11-01T10:00:00.000Z',
          sentAt: now,
          createdAt: now,
          emailSent: true,
        };
        invitations.push(inv);
        return json(inv, 201);
      }
      return json({ invitations });
    }
    if (path === `/api/invitations/${TOKEN}`) {
      return json({
        workspaceId: WS,
        workspaceName: 'Acme',
        baseId: null,
        baseName: null,
        inviterName: 'Grace Hopper',
        email: 'ada@example.test',
        role: 'editor',
        expiresAt: '2026-11-01T10:00:00.000Z',
        status: 'pending',
        emailMatches: true,
        alreadyMember: false,
      });
    }
    if (path === `/api/invitations/${TOKEN}/accept`) {
      workspaces.push({ id: WS, name: 'Acme', role: 'editor', createdAt: now, updatedAt: now });
      return json(workspaces[0]);
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
}

async function expectNoSeriousA11yIssues(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? '')
  );
  expect(serious.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))).toEqual([]);
}

test('the members page invites someone by email', async ({ page }) => {
  await mock(page, { member: true });
  await page.goto(`/w/${WS}/members`);
  const list = page.getByRole('list', { name: 'Members' });
  await expect(list.getByText('Bob Builder', { exact: true })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill('carol@example.test');
  await page.getByLabel('Role', { exact: true }).selectOption('creator');
  await page.getByRole('button', { name: 'Invite' }).click();
  await expect(
    page.getByRole('list', { name: 'Pending invitations' }).getByText('carol@example.test')
  ).toBeVisible();
  await expectNoSeriousA11yIssues(page);
  if (process.env['E2E_SCREENSHOTS']) {
    await page.screenshot({ path: `${process.env['E2E_SCREENSHOTS']}/members.png` });
  }
});

test('a toast is legible while it slides in, not only once it settles', async ({ page }) => {
  // CI's axe run caught the invite toast mid fade-in (3.4:1). Freeze its entry transition a
  // quarter of the way in, deterministically, and check the contrast there.
  await mock(page, { member: true });
  await page.goto(`/w/${WS}/members`);
  await page.getByLabel('Email', { exact: true }).fill('carol@example.test');
  await page.getByRole('button', { name: 'Invite' }).click();
  await page.locator('[data-sonner-toast][data-mounted="true"]').waitFor();
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = 100;
    }
  });
  await expectNoSeriousA11yIssues(page);
});

test('a toast moves on the DESIGN.md motion tokens (#42)', async ({ page }) => {
  await mock(page, { member: true });
  await page.goto(`/w/${WS}/members`);
  await page.getByLabel('Email', { exact: true }).fill('carol@example.test');
  await page.getByRole('button', { name: 'Invite' }).click();
  const toast = page.locator('[data-sonner-toast]').first();
  await toast.waitFor();
  const motion = await toast.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      property: style.transitionProperty,
      duration: style.transitionDuration,
      easing: style.transitionTimingFunction,
    };
  });
  // Slide 220 ms (the modal token), fades and height 180 ms (popover), standard easing.
  expect(motion.property).toBe('transform, opacity, height, box-shadow');
  expect(motion.duration).toBe('0.22s, 0.18s, 0.18s, 0.18s');
  expect(motion.easing).toContain('cubic-bezier(0.2, 0, 0, 1)');
});

test('an invitation link is accepted and opens the workspace', async ({ page }) => {
  await mock(page, { member: false });
  await page.goto(`/invite/${TOKEN}`);
  await expect(page.getByRole('heading', { name: 'Join Acme' })).toBeVisible();
  await expectNoSeriousA11yIssues(page);
  if (process.env['E2E_SCREENSHOTS']) {
    await page.screenshot({ path: `${process.env['E2E_SCREENSHOTS']}/invite.png` });
  }
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${WS}$`));
  await expect(page.getByRole('button', { name: 'Workspace: Acme' })).toBeVisible();
});

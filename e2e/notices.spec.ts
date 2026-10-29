import { execFileSync } from 'node:child_process';
import { latestMessageTo } from './auth/mailpit.js';
import { DEV_USER, signInDevUser } from './helpers/stack.js';
import { expect, test } from './helpers/test.js';

// Service notices against the whole Compose stack (E2E_STACK=1): the operator's notice
// command (packages/server/dist/notices/cli.js, from the checkout like e2e/seed.spec.ts's seed
// CLI, so `npm run build` first) publishes a Terms update, a dry run counts the accounts, the
// real run emails them through Mailpit (the stack's mail catcher, SMTP on localhost:1025) and a
// second run sends nothing twice; the app shows the notice as a banner the user dismisses for
// good. The notice is withdrawn afterwards, so other specs never see its banner.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

const DAY = 86_400_000;
const smtpEnv = {
  ...process.env,
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  SMTP_SECURE: 'false',
  SMTP_FROM: 'OpenRows <no-reply@openrows.test>',
};

function notices(args: string[], env: NodeJS.ProcessEnv = process.env): unknown {
  const out = execFileSync('node', ['packages/server/dist/notices/cli.js', ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env,
  });
  return JSON.parse(out);
}

let noticeId: string | undefined;
test.afterAll(() => {
  if (noticeId) notices(['withdraw', noticeId]);
});

test('a Terms notice is emailed once to every account and shown until dismissed', async ({
  page,
}) => {
  await signInDevUser(page);
  const title = `We're updating our Terms of Service (${Date.now()})`;
  const effective = new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10);

  // Less than 14 days' notice for a Terms change is refused.
  expect(() =>
    notices([
      'create',
      '--kind=terms',
      `--title=${title}`,
      '--summary=Too soon.',
      '--url=https://openrows.io/terms',
      `--effective=${new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10)}`,
    ])
  ).toThrow();

  const created = notices([
    'create',
    '--kind=terms',
    `--title=${title}`,
    '--summary=Clearer rules for public forms and share links.',
    '--url=https://openrows.io/terms',
    `--effective=${effective}`,
  ]) as { id: string; audience: string };
  noticeId = created.id;
  expect(created.audience).toBe('everyone');

  const dry = notices(['send', created.id, '--dry-run']) as { recipients: number; sent: number };
  expect(dry.recipients).toBeGreaterThanOrEqual(1);
  expect(dry.sent).toBe(0);

  const appUrl = new URL(page.url()).origin;
  const sent = notices(['send', created.id], { ...smtpEnv, APP_URL: appUrl }) as {
    recipients: number;
    sent: number;
    failed: number;
  };
  expect(sent).toMatchObject({ recipients: dry.recipients, sent: dry.recipients, failed: 0 });
  const mail = await latestMessageTo(DEV_USER.email, 15_000, title);
  expect(mail).toContain('Clearer rules for public forms and share links.');
  expect(mail).toContain('Read the details: https://openrows.io/terms');
  // Every account had it: the next run has no one left.
  const again = notices(['send', created.id], { ...smtpEnv, APP_URL: appUrl }) as {
    recipients: number;
  };
  expect(again.recipients).toBe(0);

  // The in-app banner, dismissed per user (on the server, so it stays dismissed).
  await page.reload();
  const banner = page.getByRole('region', { name: 'Service notice' }).filter({ hasText: title });
  await expect(banner).toBeVisible();
  await expect(banner.getByRole('link', { name: 'Read the details' })).toHaveAttribute(
    'href',
    'https://openrows.io/terms'
  );
  await banner.getByRole('button', { name: `Dismiss notice: ${title}` }).click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('current-user')).toBeVisible();
  await expect(banner).toHaveCount(0);
});

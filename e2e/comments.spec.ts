import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { signInDevUser } from './helpers/stack.js';
import { expect, test, watchCsp } from './helpers/test.js';

// Record comments against the whole Compose stack (E2E_STACK=1): two browser contexts
// (two sessions of the dev user) have the same record open. A comment with an @mention picked
// from the autocomplete in one appears live in the other, with the mention and the row header's
// comment count.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

type Table = { id: string; fields: { id: string; name: string }[] };

const gridCell = (page: Page, row: number, col: number) =>
  page.getByRole('grid').locator(`[data-cell="${row}:${col}"]`);

/** Opens the grid at `url` and expands its first record. */
async function openRecord(page: Page, url: string) {
  await page.goto(url);
  await expect(gridCell(page, 0, 0)).toHaveText('Launch plan');
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-status', 'live');
  await gridCell(page, 0, 0).click();
  await page.keyboard.press('Space');
  const panel = page.getByTestId('comments-panel');
  await expect(panel.getByText('No comments yet.')).toBeVisible();
  return panel;
}

test('a comment with a mention appears live in a second browser', async ({
  page,
  browser,
  baseURL,
}) => {
  await signInDevUser(page);
  const origin = new URL(page.url()).origin;
  const post = async <T>(path: string, data: unknown): Promise<T> => {
    const res = await page.request.post(path, { data, headers: { origin } });
    expect(res.status(), path).toBe(201);
    return (await res.json()) as T;
  };
  const ws = await post<{ id: string }>('/api/workspaces', { name: `Comments ${Date.now()}` });
  const base = await post<{ id: string }>(`/api/workspaces/${ws.id}/bases`, { name: 'Launch' });
  const table = await post<Table>(`/api/bases/${base.id}/tables`, { name: 'Tasks' });
  const name = table.fields.find((f) => f.name === 'Name')?.id ?? '';
  await post(`/api/tables/${table.id}/records`, { fields: { [name]: 'Launch plan' } });
  const url = `/b/${base.id}/${table.id}`;

  const context = await browser.newContext({ baseURL });
  const seen = await watchCsp(context, new URL(baseURL ?? origin).origin);
  const other = await context.newPage();
  try {
    await signInDevUser(other);
    const mine = await openRecord(page, url);
    const theirs = await openRecord(other, url);

    // Write it with the autocomplete: `@` lists the people with access to the base.
    const box = mine.getByRole('combobox', { name: 'Write a comment' });
    await box.click();
    await box.pressSequentially('Ready for review @');
    const suggestions = page.getByRole('listbox', { name: 'People to mention' });
    await expect(suggestions.getByRole('option').first()).toBeVisible();
    await page.keyboard.press('Enter');
    // The pick is a chip in the composer.
    await expect(box.getByTestId('mention-chip')).toBeVisible();
    await box.pressSequentially('please');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(mine.getByTestId('comment')).toHaveCount(1);
    await expect(box).toHaveText('');

    // The other browser shows it without a reload: text, mention and the row header count.
    const comment = theirs.getByTestId('comment');
    await expect(comment).toContainText('Ready for review', { timeout: 5000 });
    await expect(comment.getByTestId('mention')).toBeVisible();
    await expect(comment).toContainText('please');
    await expect(other.getByTestId('comments-count')).toHaveText('1');
    await expect(other.getByTestId('comment-count')).toContainText('1');

    // A reaction shows live too.
    await mine.getByRole('button', { name: 'Add reaction' }).click({ force: true });
    await page.getByRole('menuitem', { name: 'thumbsUp' }).click();
    await expect(theirs.getByRole('button', { name: 'thumbsUp: 1' })).toBeVisible();

    const axe = await new AxeBuilder({ page })
      .include('[data-testid="comments-panel"]')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(
      axe.violations
        .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
        .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))
    ).toEqual([]);
    expect(seen).toEqual([]);
  } finally {
    await context.close();
  }
});

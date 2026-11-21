import { INTERFACE_LAYOUTS } from '@openrows/shared';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NewPageDialog } from './InterfacesPage';
import { LAYOUT_LABELS } from './model';

// jsdom has no layout, so this checks the structure that keeps the dialog on screen: the dialog
// is capped by the viewport and only the layout list scrolls. e2e/interfaces-designer.spec.ts
// checks Create page in the viewport at 1280×720 in Chromium.

const tables = [{ id: '01900000-0000-7000-8000-000000000100', name: 'Features' }];

describe('the new-page dialog', () => {
  it.each([
    ['a new interface', null, 'New interface'],
    ['a page in an interface', 'Ops', 'New page in Ops'],
  ])('scrolls only the layout list for %s', (_, interfaceName, title) => {
    render(
      <NewPageDialog
        interfaceName={interfaceName}
        tables={tables}
        onClose={vi.fn()}
        onCreate={vi.fn(async () => {})}
      />
    );
    const dialog = screen.getByRole('dialog', { name: title });
    expect(dialog.className).toMatch(/(^|\s)max-h-\[90dvh\](\s|$)/);
    expect(dialog.className).toMatch(/(^|\s)flex-col(\s|$)/);

    const group = within(dialog).getByRole('group', { name: 'Layout' });
    const list = within(group).getByTestId('layout-options');
    expect(list.className).toMatch(/(^|\s)overflow-y-auto(\s|$)/);
    expect(list.className).toMatch(/(^|\s)min-h-0(\s|$)/);
    // Every layout is offered, in the scrolling list.
    const radios = within(list).getAllByRole('radio');
    expect(radios).toHaveLength(INTERFACE_LAYOUTS.length);
    for (const layout of INTERFACE_LAYOUTS) {
      expect(
        within(list).getByRole('radio', { name: new RegExp(LAYOUT_LABELS[layout]) })
      ).toBeTruthy();
    }

    // The rest stays outside it, so it never scrolls away.
    const outside = [
      within(dialog).getByLabelText('Page name'),
      within(dialog).getByLabelText('Table'),
      within(dialog).getByRole('button', { name: 'Create page' }),
      within(dialog).getByRole('button', { name: 'Cancel' }),
    ];
    if (!interfaceName) outside.push(within(dialog).getByLabelText('Interface name'));
    for (const el of outside) expect(list.contains(el)).toBe(false);
  });
});

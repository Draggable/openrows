import type { Collaborator, FieldMeta, FieldTypeName } from '@openrows/shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Editor } from '@tiptap/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DirectoryContext } from '../../collaborators/context';
import { buttonTarget, CellContent } from './CellContent';
import { CellEditor } from './editors';
import { editorKind } from './model';
import { RichText } from './RichText';

/** The TipTap editor behind a rich text box (TipTap keeps it on the editor's element). */
const editorOf = (box: HTMLElement) => (box as HTMLElement & { editor: Editor }).editor;

// user, barcode, button and rich text.

let n = 0;
const field = (type: FieldTypeName, options: unknown = {}, name = 'Field'): FieldMeta => ({
  id: `0190a000-0000-7000-8000-${String(++n).padStart(12, '0')}`,
  tableId: '0190a000-0000-7000-8000-000000000999',
  name,
  description: null,
  type,
  options,
  isPrimary: false,
  position: n,
  createdAt: '2026-10-25T10:00:00.000Z',
  updatedAt: '2026-10-25T10:00:00.000Z',
  deletedAt: null,
});

const ada: Collaborator = {
  id: '0190a000-0000-7000-8000-00000000a0a0',
  name: 'Ada Lovelace',
  email: 'ada@example.test',
  initials: 'AL',
  color: 'violet',
};
const bob: Collaborator = {
  id: '0190a000-0000-7000-8000-00000000b0b0',
  name: 'Bob Builder',
  initials: 'BB',
  color: 'green',
};
const directory = {
  list: [ada, bob],
  byId: new Map([
    [ada.id, ada],
    [bob.id, bob],
  ]),
  meId: ada.id,
  loaded: true,
};

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

function edit(f: FieldMeta, value: unknown) {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  render(
    <DirectoryContext.Provider value={directory}>
      <div style={{ position: 'relative', width: 200, height: 34 }}>
        <CellEditor field={f} value={value} align="left" onCommit={onCommit} onCancel={onCancel} />
      </div>
    </DirectoryContext.Provider>
  );
  return { onCommit, onCancel, user: userEvent.setup() };
}

describe('user cells', () => {
  it('show one chip per person, and former members as such', () => {
    render(
      <DirectoryContext.Provider value={directory}>
        <CellContent
          field={field('user', { multiple: true })}
          value={[ada.id, bob.id, '0190a000-0000-7000-8000-00000000dead']}
        />
      </DirectoryContext.Provider>
    );
    expect(screen.getAllByTestId('user-chip').map((c) => c.textContent)).toEqual([
      'ALAda Lovelace',
      'BBBob Builder',
    ]);
    expect(screen.getByText('Former member')).toBeTruthy();
  });

  it('pick one person, or toggle several and save on Escape', async () => {
    const single = field('user', {}, 'Owner');
    expect(editorKind(single)).toBe('user');
    const one = edit(single, null);
    await one.user.type(screen.getByRole('combobox'), 'bob');
    await one.user.keyboard('{Enter}');
    expect(one.onCommit).toHaveBeenCalledWith({ value: [bob.id] }, 'stay');
    cleanup();

    const many = edit(field('user', { multiple: true }, 'People'), [ada.id]);
    const list = screen.getByRole('listbox', { name: 'People' });
    expect(list.getAttribute('aria-multiselectable')).toBe('true');
    await many.user.click(within(list).getByText('Bob Builder'));
    await many.user.keyboard('{Escape}');
    expect(many.onCommit).toHaveBeenCalledWith({ value: [ada.id, bob.id] }, 'stay');
  });
});

describe('barcode cells', () => {
  it('show the code and its type', () => {
    render(
      <CellContent field={field('barcode')} value={{ text: '4006381333931', type: 'ean13' }} />
    );
    expect(screen.getByText('4006381333931')).toBeTruthy();
    expect(screen.getByText('EAN-13')).toBeTruthy();
  });

  it('detect the type, and refuse a value that is invalid for the chosen type', async () => {
    const f = field('barcode', {}, 'Code');
    const ok = edit(f, null);
    await ok.user.type(screen.getByRole('textbox', { name: 'Code' }), '4006381333931{Enter}');
    expect(ok.onCommit).toHaveBeenCalledWith(
      { value: { text: '4006381333931', type: 'ean13' } },
      'stay'
    );
    cleanup();

    const bad = edit(f, null);
    await bad.user.selectOptions(screen.getByRole('combobox'), 'ean13');
    await bad.user.type(screen.getByRole('textbox', { name: 'Code' }), '4006381333932');
    expect(screen.getByRole('alert').textContent).toContain('Not a valid EAN-13 value');
    await bad.user.keyboard('{Enter}');
    expect(bad.onCommit.mock.calls[0]?.[0]).toHaveProperty('error');
  });
});

describe('button cells', () => {
  it('open the URL in a new tab with noopener noreferrer', () => {
    render(
      <CellContent field={field('button', { label: 'Open site' })} value="https://openrows.io/x" />
    );
    const link = screen.getByRole('link', { name: 'Open site' });
    expect(link.getAttribute('href')).toBe('https://openrows.io/x');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(editorKind(field('button'))).toBe('none');
  });

  it('never link to anything but http(s)', () => {
    render(<CellContent field={field('button', { label: 'Go' })} value="javascript:alert(1)" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Go').closest('[aria-disabled]')).toBeTruthy();
  });
});

describe('automation buttons (#110, #126)', () => {
  it('run where the record is known, and only button fields get a target', async () => {
    const button = field('button', { label: 'Approve', action: 'runAutomation' });
    const recordId = '0190a000-0000-7000-8000-00000000cccc';
    expect(buttonTarget(button, recordId)).toEqual({ tableId: button.tableId, recordId });
    expect(buttonTarget(button, undefined)).toBeUndefined();
    expect(buttonTarget(field('singleLineText'), recordId)).toBeUndefined();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ started: 1 })));
    vi.stubGlobal('fetch', fetchMock);
    const onKey = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: a card's Enter, as in kanban
      <div onKeyDown={onKey}>
        <CellContent field={button} value={null} button={buttonTarget(button, recordId)} />
      </div>
    );
    const run = screen.getByRole('button', { name: 'Approve' });
    fireEvent.keyDown(run, { key: 'Enter' });
    expect(onKey).not.toHaveBeenCalled();
    fireEvent.click(run);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain(
      `/api/tables/${button.tableId}/records/${recordId}/buttons/${button.id}`
    );
    vi.unstubAllGlobals();
  });

  it('show inert without a record', () => {
    render(
      <CellContent
        field={field('button', { label: 'Run', action: 'runAutomation' })}
        value={null}
      />
    );
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
    expect(screen.getByText('Run').closest('[aria-disabled]')).toBeTruthy();
  });
});

describe('rich text', () => {
  it('renders Markdown with elements, never HTML', () => {
    const { container } = render(
      <RichText
        text={
          '# Plan\n**bold** _it_ [site](https://openrows.io)\n- [x] done\n<img src=x onerror=alert(1)><script>alert(1)</script>[bad](javascript:alert(1))'
        }
      />
    );
    expect(container.querySelector('h3')?.textContent).toBe('Plan');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('em')?.textContent).toBe('it');
    expect(container.querySelector('script, img')).toBeNull();
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://openrows.io']);
    expect(container.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
    // The raw tag shows as text, not as an element.
    expect(container.textContent).toContain('<script>');
  });

  it('shows plain text in the grid cell, and the editor formats with the toolbar', async () => {
    render(<CellContent field={field('longText', { richText: true })} value={'**Hi** _there_'} />);
    expect(screen.getByText('Hi there')).toBeTruthy();
    cleanup();

    const f = field('longText', { richText: true }, 'Notes');
    const { onCommit, user } = edit(f, 'word');
    // The WYSIWYG editor is a lazy chunk.
    const box = await screen.findByRole('textbox', { name: 'Notes' });
    const editor = editorOf(box);
    editor.commands.selectAll();
    await user.click(screen.getByRole('button', { name: /^Bold/ }));
    expect(box.querySelector('strong')?.textContent).toBe('word');
    // The Markdown view shows the source, and edits there come back to the editor.
    await user.click(screen.getByRole('button', { name: 'Markdown' }));
    const source = screen.getByRole('textbox', { name: 'Notes (Markdown)' }) as HTMLTextAreaElement;
    expect(source.value).toBe('**word**');
    await user.click(screen.getByRole('button', { name: 'Markdown' }));
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(onCommit).toHaveBeenCalledWith({ value: '**word**' }, 'stay');
  });

  it('sanitizes pasted HTML to the Markdown subset: no script, handler or unsafe link', async () => {
    const f = field('longText', { richText: true }, 'Notes');
    const { onCommit } = edit(f, '');
    const box = await screen.findByRole('textbox', { name: 'Notes' });
    const editor = editorOf(box);
    act(() =>
      editor.view.pasteHTML(
        [
          '<p><b>Bold</b> <img src=x onerror="alert(1)"><script>alert(1)</script>',
          '<a href="javascript:alert(1)">bad</a> <a href="https://openrows.io" onclick="alert(1)">good</a>',
          '<span style="color:red" onmouseover="alert(1)">styled</span></p>',
          '<iframe src="https://evil.example"></iframe><svg onload="alert(1)"></svg>',
        ].join(''),
        // jsdom has no ClipboardEvent; the editor only reads the HTML.
        new Event('paste') as ClipboardEvent
      )
    );
    expect(box.querySelector('script, img, iframe, svg, [onerror], [onclick], [style]')).toBeNull();
    const hrefs = [...box.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://openrows.io']);
    expect(box.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    const saved = onCommit.mock.calls[0]?.[0]?.value as string;
    expect(saved).toBe('**Bold** bad [good](https://openrows.io)styled');
    expect(saved).not.toMatch(/javascript|<|onerror|alert/);
  });

  it('opens a link with Ctrl/Cmd click only, and only a safe one', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const f = field('longText', { richText: true }, 'Notes');
    edit(f, 'see [docs](https://openrows.io/docs)');
    const box = await screen.findByRole('textbox', { name: 'Notes' });
    const link = box.querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    const editor = editorOf(box);
    const pos = editor.view.posAtDOM(link.firstChild as Node, 1);
    const click = (init: MouseEventInit) =>
      editor.view.someProp('handleClick', (f) =>
        f(editor.view, pos, new MouseEvent('click', init))
      );
    expect(click({})).toBeFalsy();
    expect(open).not.toHaveBeenCalled();
    expect(click({ ctrlKey: true })).toBe(true);
    expect(click({ metaKey: true })).toBe(true);
    expect(open).toHaveBeenCalledWith('https://openrows.io/docs', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  it('adds links only to http(s) and mailto', async () => {
    const f = field('longText', { richText: true }, 'Notes');
    const { onCommit, user } = edit(f, 'site');
    const box = await screen.findByRole('textbox', { name: 'Notes' });
    editorOf(box).commands.selectAll();
    await user.click(screen.getByRole('button', { name: 'Link' }));
    const url = screen.getByRole('textbox', { name: 'Link URL' });
    await user.type(url, 'javascript:alert(1){Enter}');
    expect(screen.getByRole('alert').textContent).toMatch(/http/);
    expect(box.querySelector('a')).toBeNull();
    await user.clear(url);
    await user.type(url, 'openrows.io{Enter}');
    expect(box.querySelector('a')?.getAttribute('href')).toBe('https://openrows.io');
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(onCommit).toHaveBeenCalledWith({ value: '[site](https://openrows.io)' }, 'stay');
  });
});

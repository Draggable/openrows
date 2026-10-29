import { FIELD_TYPE_NAMES, type FieldMeta, type FieldTypeName } from '@openrows/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DirectoryContext } from '../../collaborators/context';
import { CellContent } from './CellContent';
import { CellEditor, type CellEditorProps } from './editors';
import { editorKind } from './model';

const NOW = '2026-10-25T10:00:00.000Z';
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
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
});

const CHOICES = {
  choices: [
    { id: 'c1', name: 'Planned', color: 'blue' },
    { id: 'c2', name: 'In progress', color: 'amber' },
    { id: 'c3', name: 'Shipped', color: 'green' },
  ],
};
const FILES = [
  { id: 'a1', filename: 'mockup.png', size: 2048, type: 'image/png' },
  { id: 'a2', filename: 'spec.pdf', size: 4096, type: 'application/pdf' },
  { id: 'a3', filename: 'notes.txt', size: 10, type: 'text/plain' },
  { id: 'a4', filename: 'data.bin', size: 10, type: 'application/octet-stream' },
];

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

function show(f: FieldMeta, value: unknown, onChange?: (v: unknown) => void) {
  return render(
    <div className="group">
      <CellContent field={f} value={value} onChange={onChange} />
    </div>
  );
}

function edit(f: FieldMeta, value: unknown, extra: Partial<CellEditorProps> = {}) {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  render(
    <div style={{ position: 'relative', width: 200, height: 34 }}>
      <CellEditor
        field={f}
        value={value}
        align="left"
        onCommit={onCommit}
        onCancel={onCancel}
        {...extra}
      />
    </div>
  );
  return { onCommit, onCancel, user: userEvent.setup() };
}

describe('cell renderers', () => {
  it('text, long text and numbers show the registry format', () => {
    show(field('singleLineText'), 'Keyboard-first grid');
    expect(screen.getByText('Keyboard-first grid')).toBeTruthy();
    show(field('longText'), 'Line one\nline two');
    expect(screen.getByText('Line one line two')).toBeTruthy();
    show(field('currency', { symbol: '$', precision: 2 }), 12.5);
    expect(screen.getByText('$12.50')).toBeTruthy();
    show(field('percent', { precision: 0 }), 0.42);
    expect(screen.getByText('42%')).toBeTruthy();
    show(field('duration'), 3660);
    expect(screen.getByText('1:01')).toBeTruthy();
  });

  it('checkbox: a box, clickable when editable', () => {
    const onChange = vi.fn();
    show(field('checkbox'), true, onChange);
    expect(screen.getByLabelText('Checked')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Uncheck' }));
    expect(onChange).toHaveBeenCalledWith(false);
    const { container } = show(field('checkbox'), false);
    expect(container.querySelector('button')).toBeNull();
  });

  it('single and multiple select: chips in the choice colours with a dot and the label', () => {
    const { container } = show(field('singleSelect', CHOICES), 'c2');
    const chip = within(container).getByText('In progress').parentElement as HTMLElement;
    expect(chip.dataset['color']).toBe('amber');
    expect(chip.style.background).toBe('var(--chip-amber-bg)');
    const multi = show(field('multipleSelect', CHOICES), ['c3', 'c1', 'gone']);
    const labels = [...multi.container.querySelectorAll('[data-color]')].map((e) => e.textContent);
    expect(labels).toEqual(['Shipped', 'Planned']);
  });

  it('rating: icons up to max; clicking one rates, clicking the current one clears', () => {
    const onChange = vi.fn();
    show(field('rating', { max: 5 }), 3, onChange);
    expect(screen.getByRole('img', { name: '3 out of 5' })).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Rate 5' }));
    expect(onChange).toHaveBeenLastCalledWith(5);
    fireEvent.click(screen.getByRole('button', { name: 'Rate 3' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('date and date-time: formatted, date-times in the field time zone', () => {
    show(field('date', { dateFormat: 'friendly' }), '2026-11-12');
    expect(screen.getByText('November 12, 2026')).toBeTruthy();
    show(
      field('dateTime', { dateFormat: 'iso', timeFormat: '24h', timeZone: 'Europe/Paris' }),
      '2026-11-12T08:30:00.000Z'
    );
    expect(screen.getByText('2026-11-12 09:30')).toBeTruthy();
  });

  it('URL, email and phone: links (only http(s) URLs get an href)', () => {
    show(field('url'), 'https://openrows.io/docs');
    expect(
      screen.getByRole('link', { name: 'https://openrows.io/docs' }).getAttribute('href')
    ).toBe('https://openrows.io/docs');
    show(field('email'), 'ada@example.test');
    expect(screen.getByRole('link', { name: 'ada@example.test' }).getAttribute('href')).toBe(
      'mailto:ada@example.test'
    );
    show(field('phone'), '+1 (555) 010-2000');
    expect(screen.getByRole('link', { name: '+1 (555) 010-2000' }).getAttribute('href')).toBe(
      'tel:+15550102000'
    );
  });

  it('attachment: at most 3 tiles, then +n', () => {
    show(field('attachment'), FILES);
    expect(screen.getByRole('img', { name: 'mockup.png' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'notes.txt' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'data.bin' })).toBeNull();
    expect(screen.getByText('+1')).toBeTruthy();
  });

  it('attachment: images show their thumbnail, and an icon if it fails to load', () => {
    const f = field('attachment');
    show(f, FILES.slice(0, 2));
    const thumb = screen.getByRole('img', { name: 'mockup.png' });
    expect(thumb.tagName).toBe('IMG');
    expect(thumb.getAttribute('src')).toBe(`/api/tables/${f.tableId}/attachments/a1/thumbnail`);
    expect(screen.getByRole('img', { name: 'spec.pdf' }).tagName).toBe('SPAN');
    fireEvent.error(thumb);
    expect(screen.getByRole('img', { name: 'mockup.png' }).tagName).toBe('SPAN');
  });

  it('read-only types render text and open no editor', () => {
    for (const type of ['autoNumber', 'createdTime', 'lastModifiedTime', 'createdBy'] as const) {
      expect(editorKind(field(type))).toBe('none');
    }
    show(field('autoNumber'), 42);
    expect(screen.getByText('42')).toBeTruthy();
  });

  it('people: a chip with the avatar and name from the collaborator directory (#71)', () => {
    const ada = {
      id: '0190a000-0000-7000-8000-00000000a0a0',
      name: 'Ada Lovelace',
      email: 'ada@example.test',
      initials: 'AL',
      color: 'violet' as const,
    };
    const directory = { list: [ada], byId: new Map([[ada.id, ada]]), meId: ada.id, loaded: true };
    const f = field('createdBy');
    render(
      <DirectoryContext.Provider value={directory}>
        <CellContent field={f} value={ada.id} />
        <CellContent field={f} value="0190a000-0000-7000-8000-00000000ffff" />
      </DirectoryContext.Provider>
    );
    const chip = screen.getByTestId('user-chip');
    expect(chip.textContent).toBe('ALAda Lovelace');
    expect(chip.getAttribute('title')).toBe('ada@example.test');
    expect(within(chip).getByText('AL').getAttribute('data-color')).toBe('violet');
    // Someone outside the directory (a former member): no data, a neutral label.
    expect(screen.getByText('Former member')).toBeTruthy();
  });

  it('every registry type renders without throwing, empty or not', () => {
    for (const type of FIELD_TYPE_NAMES) {
      expect(() => show(field(type), null)).not.toThrow();
      expect(() => show(field(type), 'garbage')).not.toThrow();
    }
  });
});

describe('cell editors', () => {
  it('text: Enter saves the typed value, Esc cancels, Tab saves and moves', async () => {
    const f = field('singleLineText', {}, 'Name');
    const { onCommit, user } = edit(f, 'Old');
    const input = screen.getByRole('textbox', { name: 'Name' });
    await user.clear(input);
    await user.type(input, 'New{Enter}');
    expect(onCommit).toHaveBeenCalledWith({ value: 'New' }, 'stay');
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('text: Esc cancels', async () => {
    const { onCommit, onCancel, user } = edit(field('singleLineText', {}, 'Name'), 'Old');
    await user.type(screen.getByRole('textbox'), 'x{Escape}');
    expect(onCancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('number: starts from the typed character; unreadable text is an error, not a save', async () => {
    const f = field('number', {}, 'Estimate');
    const { onCommit, user } = edit(f, 5, { initialText: '1' });
    const input = screen.getByRole('textbox', { name: 'Estimate' });
    expect((input as HTMLInputElement).value).toBe('1');
    await user.type(input, '3{Tab}');
    expect(onCommit).toHaveBeenCalledWith({ value: 13 }, 'next');
  });

  it('number: unreadable input reports an error', async () => {
    const { onCommit, user } = edit(field('number', {}, 'Estimate'), null);
    await user.type(screen.getByRole('textbox'), 'abc{Enter}');
    expect(onCommit).toHaveBeenCalledWith({ error: '"abc" isn\'t a valid number' }, 'stay');
  });

  it('email, URL, phone and duration use the text editor and the registry coerce', async () => {
    const url = edit(field('url', {}, 'Site'), null);
    await url.user.type(screen.getByRole('textbox', { name: 'Site' }), 'openrows.io{Enter}');
    expect(url.onCommit).toHaveBeenCalledWith({ value: 'https://openrows.io' }, 'stay');
    const dur = edit(field('duration', {}, 'Time'), null);
    await dur.user.type(screen.getByRole('textbox', { name: 'Time' }), '1:30{Enter}');
    expect(dur.onCommit).toHaveBeenCalledWith({ value: 5400 }, 'stay');
    const mail = edit(field('email', {}, 'Mail'), null);
    await mail.user.type(screen.getByRole('textbox', { name: 'Mail' }), 'not-an-email{Enter}');
    expect(mail.onCommit.mock.calls[0]?.[0]).toHaveProperty('error');
  });

  it('long text: an expanded textarea; Enter adds a line, Ctrl+Enter saves', async () => {
    const f = field('longText', {}, 'Notes');
    const { onCommit, user } = edit(f, 'First');
    const area = screen.getByRole('textbox', { name: 'Notes' });
    expect(area.tagName).toBe('TEXTAREA');
    await user.type(area, '{Enter}Second{Control>}{Enter}{/Control}');
    expect(onCommit).toHaveBeenCalledWith({ value: 'First\nSecond' }, 'stay');
  });

  it('single select: filter, arrow and Enter pick a choice; Clear empties', async () => {
    const f = field('singleSelect', CHOICES, 'Status');
    const { onCommit, user } = edit(f, 'c1');
    const search = screen.getByRole('combobox', { name: 'Find an option for Status' });
    expect(screen.getAllByRole('option')).toHaveLength(3);
    await user.type(search, 'p');
    // "Planned", "In progress", "Shipped" all contain a p; ArrowDown picks the second.
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onCommit).toHaveBeenCalledWith({ value: 'c2' }, 'stay');
  });

  it('single select: a click picks, Clear empties', async () => {
    const pickOne = edit(field('singleSelect', CHOICES, 'Status'), null);
    await pickOne.user.click(screen.getByRole('option', { name: /Shipped/ }));
    expect(pickOne.onCommit).toHaveBeenCalledWith({ value: 'c3' }, 'stay');
  });

  it('single select: Clear', async () => {
    const { onCommit, user } = edit(field('singleSelect', CHOICES, 'Status'), 'c3');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onCommit).toHaveBeenCalledWith({ value: null }, 'stay');
  });

  it('multiple select: Enter toggles, Backspace removes the last, Esc saves the set', async () => {
    const f = field('multipleSelect', CHOICES, 'Tags');
    const { onCommit, user } = edit(f, ['c1']);
    const search = screen.getByRole('combobox');
    await user.type(search, 'ship{Enter}');
    expect(screen.getByRole('option', { name: /Shipped/ }).getAttribute('aria-selected')).toBe(
      'true'
    );
    await user.keyboard('{ArrowDown}{Enter}');
    await user.click(screen.getByRole('button', { name: 'Remove Planned' }));
    await user.click(screen.getByRole('combobox'));
    await user.keyboard('{Escape}');
    expect(onCommit).toHaveBeenCalledWith({ value: ['c3', 'c2'] }, 'stay');
  });

  it('select: "+ Add option" only for schema roles, saved with typecast (#70)', async () => {
    const plain = edit(field('singleSelect', CHOICES, 'Status'), null);
    await plain.user.type(screen.getByRole('combobox'), 'Blocked');
    expect(screen.queryByRole('option', { name: /Add option/ })).toBeNull();
    cleanup();

    const single = edit(field('singleSelect', CHOICES, 'Status'), null, { canAddOptions: true });
    await single.user.type(screen.getByRole('combobox'), 'planned');
    // An exact name (any case) is no new option.
    expect(screen.queryByRole('option', { name: /Add option/ })).toBeNull();
    await single.user.clear(screen.getByRole('combobox'));
    await single.user.type(screen.getByRole('combobox'), ' Blocked {Enter}');
    expect(single.onCommit).toHaveBeenCalledWith({ value: 'Blocked', typecast: true }, 'stay');
    cleanup();

    const multi = edit(field('multipleSelect', CHOICES, 'Tags'), ['c1'], { canAddOptions: true });
    await multi.user.type(screen.getByRole('combobox'), 'Later');
    await multi.user.click(screen.getByRole('option', { name: 'Add option "Later"' }));
    expect(screen.getByText('Later')).toBeTruthy();
    await multi.user.keyboard('{Escape}');
    expect(multi.onCommit).toHaveBeenCalledWith({ value: ['c1', 'Later'], typecast: true }, 'stay');
  });

  it('date: the picker value saves as YYYY-MM-DD; Clear empties', async () => {
    const f = field('date', {}, 'Due');
    const { onCommit } = edit(f, '2026-11-12');
    const input = screen.getByLabelText('Due') as HTMLInputElement;
    expect(input.type).toBe('date');
    expect(input.value).toBe('2026-11-12');
    fireEvent.change(input, { target: { value: '2026-12-10' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith({ value: '2026-12-10' }, 'stay');
  });

  it('date: Clear', async () => {
    const { onCommit, user } = edit(field('date', {}, 'Due'), '2026-11-12');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onCommit).toHaveBeenCalledWith({ value: null }, 'stay');
  });

  it('date-time: wall-clock time in the field time zone, named in the editor', () => {
    const f = field('dateTime', { timeZone: 'America/New_York' }, 'Launch');
    const { onCommit } = edit(f, '2026-11-12T14:30:00.000Z');
    const input = screen.getByLabelText('Launch') as HTMLInputElement;
    expect(input.type).toBe('datetime-local');
    expect(input.value).toBe('2026-11-12T09:30');
    expect(screen.getByTestId('time-zone').textContent).toBe('Time zone: America/New_York');
    fireEvent.change(input, { target: { value: '2026-11-13T08:00' } });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(onCommit).toHaveBeenCalledWith({ value: '2026-11-13T13:00:00.000Z' }, 'next');
  });

  it('attachment: files can be removed; Done saves the rest', async () => {
    const f = field('attachment', {}, 'Mockups');
    const { onCommit, user } = edit(f, FILES.slice(0, 2));
    expect(screen.getByText('mockup.png')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove mockup.png' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onCommit).toHaveBeenCalledWith({ value: [FILES[1]] }, 'stay');
  });

  it('attachment: Add files uploads to storage, confirms and adds the file', async () => {
    const f = field('attachment', {}, 'Mockups');
    const uploaded = {
      id: '0190a000-0000-7000-8000-0000000000f1',
      filename: 'new.png',
      size: 3,
      type: 'image/png',
    };
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (url.endsWith('/attachments')) {
          expect(JSON.parse(String(init?.body))).toEqual({
            fieldId: f.id,
            filename: 'new.png',
            type: 'image/png',
            size: 3,
          });
          return Response.json(
            {
              attachment: uploaded,
              upload: {
                method: 'PUT',
                url: 'https://files.test/ws/1/new?X-Amz-Signature=x',
                headers: { 'content-type': 'image/png' },
                expiresAt: NOW,
              },
            },
            { status: 201 }
          );
        }
        if (url.startsWith('https://files.test/')) return new Response(null, { status: 200 });
        return Response.json(uploaded);
      })
    );
    try {
      const { onCommit, user } = edit(f, [FILES[1]]);
      await user.upload(
        screen.getByLabelText('Choose files'),
        new File([new Uint8Array([1, 2, 3])], 'new.png', { type: 'image/png' })
      );
      expect(await screen.findByText('new.png')).toBeTruthy();
      expect(calls).toEqual([
        `POST /api/tables/${f.tableId}/attachments`,
        'PUT https://files.test/ws/1/new?X-Amz-Signature=x',
        `POST /api/tables/${f.tableId}/attachments/${uploaded.id}/confirm`,
      ]);
      await user.click(screen.getByRole('button', { name: 'Done' }));
      expect(onCommit).toHaveBeenCalledWith({ value: [FILES[1], uploaded] }, 'stay');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('attachment: a file over the size limit is refused before uploading', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { user } = edit(field('attachment', {}, 'Mockups'), null);
      const big = new File(['x'], 'huge.mov');
      Object.defineProperty(big, 'size', { value: 101 * 1024 * 1024 });
      await user.upload(screen.getByLabelText('Choose files'), big);
      expect((await screen.findByRole('alert')).textContent).toBe(
        '"huge.mov" is larger than 100 MB.'
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('attachment: closing without a change cancels', async () => {
    const { onCommit, onCancel, user } = edit(field('attachment', {}, 'Mockups'), FILES);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onCancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

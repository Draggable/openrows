import {
  type FieldMeta,
  INTERFACE_LAYOUTS,
  type InterfacePageConfig,
  interfacePageConfigSchema,
} from '@openrows/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ListFields } from './InterfacesPage';
import { LayoutSettings } from './LayoutSettings';
import { elementTypesFor, LAYOUT_DESCRIPTIONS, LAYOUT_LABELS } from './model';

const uuid = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const TABLE = uuid(100);
const OTHER_TABLE = uuid(101);

const field = (n: number, name: string, type: string, options: unknown = {}) =>
  ({ id: uuid(n), name, type, options, isPrimary: n === 1 }) as FieldMeta;

const name = field(1, 'Name', 'singleLineText');
const parent = field(2, 'Parent', 'link', { linkedTableId: TABLE });
const project = field(3, 'Project', 'link', { linkedTableId: OTHER_TABLE });
const notes = field(4, 'Details', 'singleLineText');
const fields = [name, parent, project, notes];

describe('hierarchical list pages in the designer', () => {
  it('is offered with the other layouts, read-only and without record elements', () => {
    expect(INTERFACE_LAYOUTS).toContain('list');
    expect(LAYOUT_LABELS.list).toBe('Hierarchical list');
    expect(LAYOUT_DESCRIPTIONS.list).toMatch(/nested under their parent/);
    expect(elementTypesFor('list')).not.toContain('field');
  });

  it('names the parent field from the links to the same table, and saves it', () => {
    const config: InterfacePageConfig = interfacePageConfigSchema.parse({
      layout: 'list',
      tableId: TABLE,
      fields: [notes.id],
      list: { parentFieldId: null },
    });
    const onChange = vi.fn();
    render(<LayoutSettings config={config} fields={fields} onChange={onChange} />);
    const section = screen.getByRole('heading', { name: 'Hierarchical list' }).closest('section');
    if (!section) throw new Error('no section');
    const select = within(section).getByLabelText<HTMLSelectElement>('Parent record');
    // Only a link to records of this table can be a parent.
    expect([...select.options].map((o) => o.textContent)).toEqual(['None', 'Parent']);
    fireEvent.change(select, { target: { value: parent.id } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]?.[0] as InterfacePageConfig;
    expect(next.list).toEqual({ parentFieldId: parent.id });
    expect(next.fields).toEqual([notes.id]);
    // What the designer saves is a valid page.
    expect(interfacePageConfigSchema.safeParse(next).success).toBe(true);
    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...config, list: { parentFieldId: null } });
  });

  it('keeps the parent field out of the fields beside each title', () => {
    const config: InterfacePageConfig = interfacePageConfigSchema.parse({
      layout: 'list',
      tableId: TABLE,
      fields: [notes.id, parent.id],
      list: { parentFieldId: null },
    });
    const onChange = vi.fn();
    const { unmount } = render(
      <LayoutSettings config={config} fields={fields} onChange={onChange} />
    );
    fireEvent.change(screen.getByLabelText('Parent record'), { target: { value: parent.id } });
    const next = onChange.mock.calls[0]?.[0] as InterfacePageConfig;
    expect(next).toEqual({ ...config, fields: [notes.id], list: { parentFieldId: parent.id } });
    unmount();
    render(<ListFields config={next} fields={fields} onChange={vi.fn()} />);
    const group = screen.getByRole('group', { name: 'Fields in the list' });
    expect(within(group).queryByLabelText('Parent')).toBeNull();
    expect(within(group).getByLabelText('Details')).toBeTruthy();
    expect(within(group).getByLabelText('Project')).toBeTruthy();
  });

  it('says how to nest when the table has no link to itself', () => {
    const config = interfacePageConfigSchema.parse({ layout: 'list', tableId: TABLE });
    render(<LayoutSettings config={config} fields={[name, project]} onChange={vi.fn()} />);
    expect(screen.getByText(/Add a link to records of this table/)).toBeTruthy();
  });
});

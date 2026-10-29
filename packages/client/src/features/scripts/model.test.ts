import { describe, expect, it } from 'vitest';
import type { HostTable } from './host';
import { scriptCompletions } from './model';

const tables: HostTable[] = [
  {
    id: 't1',
    name: 'Tasks',
    description: null,
    fields: [{ id: 'f1', name: "Owner's name" } as HostTable['fields'][number]],
    views: [{ id: 'v1', name: 'Grid', type: 'grid' }],
  },
];

describe('script completions (#152)', () => {
  it('offers the members of the API object a name holds', () => {
    const base = scriptCompletions('base.get', tables);
    expect(base?.from).toBe(5);
    expect(base?.options.map((o) => o.label)).toContain('getTable');
    const table = scriptCompletions('const q = await tasksTable.sel', tables);
    expect(table?.options.map((o) => o.label)).toEqual(
      expect.arrayContaining(['selectRecordsAsync', 'createRecordsAsync'])
    );
    expect(scriptCompletions('input.', tables)?.options.map((o) => o.label)).toContain(
      'buttonsAsync'
    );
  });

  it('offers table, field and view names inside the lookups, quoted for the string', () => {
    const t = scriptCompletions("base.getTable('Ta", tables);
    expect(t).toMatchObject({ from: 15, options: [{ label: 'Tasks', apply: "Tasks')" }] });
    const f = scriptCompletions("table.getField('", tables);
    expect(f?.options[0]).toMatchObject({ label: "Owner's name", apply: "Owner\\'s name')" });
    expect(scriptCompletions('table.getView("', tables)?.options[0]?.label).toBe('Grid');
  });

  it('offers the globals for a bare word', () => {
    const r = scriptCompletions('const x = ou', tables);
    expect(r?.from).toBe(10);
    expect(r?.options.map((o) => o.label)).toContain('output');
    expect(scriptCompletions('1 + ', tables)).toBeNull();
  });
});

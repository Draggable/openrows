import type { FieldMeta, FieldTypeName } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { importableTypes, importBody, mappingErrors, planColumns, readCsv } from './model';

const NOW = '2026-10-25T10:00:00.000Z';
let n = 0;
const field = (name: string, type: FieldTypeName, isPrimary = false): FieldMeta => ({
  id: `0190a000-0000-7000-8000-${String(++n).padStart(12, '0')}`,
  tableId: '0190a000-0000-7000-8000-000000000999',
  name,
  description: null,
  type,
  options: {},
  isPrimary,
  position: n,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
});

const name = field('Name', 'singleLineText', true);
const created = field('Created', 'createdTime');
const FIELDS = [name, field('Notes', 'longText'), created];

describe('readCsv', () => {
  it('reads a file, refuses broken, empty and oversized ones', () => {
    expect(readCsv('a;b\n1;2', 7)).toEqual({
      ok: true,
      rows: [
        ['a', 'b'],
        ['1', '2'],
      ],
    });
    expect(readCsv('"open', 5)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Not a valid CSV/),
    });
    expect(readCsv('', 0)).toEqual({ ok: false, error: 'The file is empty.' });
    expect(readCsv('a', 51 * 1024 * 1024)).toMatchObject({ ok: false });
  });
});

describe('planColumns', () => {
  const rows = [
    ['name', 'Estimate', 'Notes', 'Created', ''],
    ['A', '1.5', 'x', '2024-01-01', 'q'],
    ['B', '2', 'y', '2024-01-02', ''],
  ];

  it('maps matching names to writable fields and infers new fields', () => {
    const plans = planColumns(rows, true, FIELDS, true);
    expect(plans.map((p) => p.target)).toEqual([
      { kind: 'field', fieldId: name.id },
      { kind: 'new', name: 'Estimate', type: 'number' },
      { kind: 'field', fieldId: FIELDS[1]?.id },
      // "Created" is a computed field: a new field, renamed so the names stay unique.
      { kind: 'new', name: 'Created 2', type: 'date' },
      { kind: 'new', name: 'Field 5', type: 'singleLineText' },
    ]);
    expect(plans[1]?.sample).toEqual(['1.5', '2']);
  });

  it('skips unmatched columns when the role cannot create fields', () => {
    const plans = planColumns(rows, true, FIELDS, false);
    expect(plans.map((p) => p.target.kind)).toEqual(['field', 'skip', 'field', 'skip', 'skip']);
  });

  it('treats the first row as data without a header', () => {
    const plans = planColumns(rows, false, FIELDS, true);
    expect(plans[0]?.target).toEqual({ kind: 'new', name: 'Field 1', type: 'singleLineText' });
    expect(plans[0]?.sample).toEqual(['name', 'A', 'B']);
  });
});

describe('mappingErrors and importBody', () => {
  const rows = [
    ['Title', 'Size'],
    ['A', '1.25'],
    ['B', '3'],
  ];

  it('flags taken names, double mappings and an empty mapping', () => {
    const plans = planColumns(rows, true, FIELDS, true);
    expect(mappingErrors(plans, FIELDS).size).toBe(0);
    const clash = plans.map((p) => ({
      ...p,
      target: { kind: 'new' as const, name: 'notes', type: 'singleLineText' as const },
    }));
    expect(mappingErrors(clash, FIELDS).get(0)).toMatch(/exists/);
    const twice = plans.map((p) => ({
      ...p,
      target: { kind: 'field' as const, fieldId: name.id },
    }));
    expect(mappingErrors(twice, FIELDS).get(1)).toMatch(/Another column/);
    const none = plans.map((p) => ({ ...p, target: { kind: 'skip' as const } }));
    expect(mappingErrors(none, FIELDS).get(-1)).toMatch(/at least one/);
  });

  it('builds the request with the inferred options', () => {
    const plans = planColumns(rows, true, FIELDS, true);
    const first = plans[0];
    if (!first) throw new Error('no plan');
    const body = importBody('csv', rows, true, [
      { ...first, target: { kind: 'field', fieldId: name.id } },
      ...plans.slice(1),
    ]);
    expect(body).toEqual({
      csv: 'csv',
      hasHeader: true,
      columns: [
        { index: 0, fieldId: name.id },
        { index: 1, newField: { name: 'Size', type: 'number', options: { precision: 2 } } },
      ],
    });
  });

  it('offers only writable types for new fields', () => {
    expect(importableTypes()).toContain('singleSelect');
    expect(importableTypes()).not.toContain('autoNumber');
    expect(importableTypes()).not.toContain('createdTime');
  });
});

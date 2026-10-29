import { getFieldType } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { PRODUCT_ROADMAP, random } from './template.js';

const DEFAULT_FIELDS = ['Name', 'Notes', 'Status'];

describe('the Product Roadmap template', () => {
  it('has 5 tables, 31 fields (with the 3 defaults each) and 2,000 records', () => {
    expect(PRODUCT_ROADMAP).toHaveLength(5);
    const fields = PRODUCT_ROADMAP.reduce((n, t) => n + DEFAULT_FIELDS.length + t.fields.length, 0);
    expect(fields).toBe(31);
    expect(PRODUCT_ROADMAP.reduce((n, t) => n + t.records, 0)).toBe(2000);
  });

  it('only fills fields it declares, with valid options', () => {
    const rand = random(1);
    for (const table of PRODUCT_ROADMAP) {
      const names = new Set([...DEFAULT_FIELDS, ...table.fields.map((f) => f.name)]);
      for (const f of table.fields) getFieldType(f.type).optionsSchema.parse(f.options ?? {});
      for (const key of Object.keys(table.row(0, rand))) expect(names).toContain(key);
    }
  });

  it('is deterministic for a seed', () => {
    const rows = (seed: number) => {
      const rand = random(seed);
      return PRODUCT_ROADMAP.map((t) => t.row(7, rand));
    };
    expect(rows(32)).toEqual(rows(32));
    expect(rows(32)).not.toEqual(rows(33));
  });
});

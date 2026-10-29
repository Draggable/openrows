import { describe, expect, it } from 'vitest';
import { getFieldType, isFieldTypeName } from '../fields/index.js';
import { viewConfigSchema } from '../schemas/view.js';
import { BUILT_IN_TEMPLATES, findTemplate } from './builtin.js';
import { defineTemplate, stableUuid } from './define.js';
import { TEMPLATE_FORMAT, TemplateSchema, templateSummary } from './format.js';

describe('built-in templates', () => {
  it('has 8 to 12 templates with unique slugs', () => {
    expect(BUILT_IN_TEMPLATES.length).toBeGreaterThanOrEqual(8);
    expect(BUILT_IN_TEMPLATES.length).toBeLessThanOrEqual(12);
    const slugs = BUILT_IN_TEMPLATES.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(findTemplate('crm')?.name).toBe('Sales CRM');
    expect(findTemplate('nope')).toBeNull();
  });

  for (const t of BUILT_IN_TEMPLATES) {
    describe(t.slug, () => {
      it('is a valid template document, the same after a JSON round trip', () => {
        const json = JSON.parse(JSON.stringify(t));
        expect(TemplateSchema.parse(json)).toEqual(t);
        expect(t.format).toBe(TEMPLATE_FORMAT);
      });

      it('has field options, view configs and cells the registry reads', () => {
        const fieldIds = new Set(t.tables.flatMap((x) => x.fields.map((f) => f.id)));
        for (const table of t.tables) {
          for (const f of table.fields) {
            expect(isFieldTypeName(f.type)).toBe(true);
            const type = f.type;
            if (!isFieldTypeName(type)) continue;
            expect(() => getFieldType(type).optionsSchema.parse(f.options)).not.toThrow();
            // Ids an option names are the template's own.
            for (const [k, v] of Object.entries(f.options)) {
              if (k.endsWith('Id') && typeof v === 'string' && k !== 'currencyCode') {
                const known = fieldIds.has(v) || t.tables.some((x) => x.id === v);
                expect(known, `${table.name}.${f.name}.${k}`).toBe(true);
              }
            }
          }
          for (const v of table.views) {
            expect(() => viewConfigSchema.parse(v.config)).not.toThrow();
          }
          const tableRecords = new Map(
            t.tables.map((x) => [x.id, new Set(x.records.map((r) => r.id))])
          );
          for (const r of table.records) {
            for (const [fieldId, value] of Object.entries(r.cells)) {
              const f = table.fields.find((x) => x.id === fieldId);
              if (!f || !isFieldTypeName(f.type)) throw new Error('unknown field');
              const def = getFieldType(f.type);
              expect(def.computed, `${table.name}.${f.name} is computed`).toBe(false);
              const options = def.optionsSchema.parse(f.options);
              const coerced = def.coerce(value, options);
              expect(coerced, `${table.name}.${f.name} = ${JSON.stringify(value)}`).not.toBeNull();
              if (f.type === 'link') {
                const linked = tableRecords.get(String(f.options['linkedTableId']));
                for (const id of value as string[]) expect(linked?.has(id)).toBe(true);
              }
            }
          }
        }
      });
    });
  }

  it('summarizes a template without its records', () => {
    const crm = findTemplate('crm');
    if (!crm) throw new Error('no crm');
    const s = templateSummary(crm);
    expect(s.tables.map((x) => x.name)).toEqual(['Deals', 'Companies', 'Contacts']);
    expect(s.tables[0]?.records).toBeGreaterThan(0);
    expect(JSON.stringify(s)).not.toContain('Northwind annual plan');
  });
});

describe('defineTemplate', () => {
  it('derives the same ids on every build', () => {
    expect(stableUuid('a/b')).toBe(stableUuid('a/b'));
    expect(stableUuid('a/b')).not.toBe(stableUuid('a/c'));
    expect(stableUuid('x')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('links both ways and resolves link cells by primary value', () => {
    const t = defineTemplate({
      slug: 'demo',
      name: 'Demo',
      description: '',
      category: 'Test',
      tables: [
        {
          key: 'a',
          name: 'A',
          fields: [
            { key: 'name', name: 'Name', type: 'singleLineText' },
            { key: 'b', name: 'B', type: 'link', table: 'b', inverse: { key: 'as', name: 'As' } },
          ],
          records: [{ name: 'one', b: ['x'] }],
        },
        {
          key: 'b',
          name: 'B',
          fields: [
            { key: 'name', name: 'Name', type: 'singleLineText' },
            { key: 'n', name: 'N', type: 'count', link: 'as' },
          ],
          records: [{ name: 'x' }],
        },
      ],
    });
    const [a, b] = t.tables;
    const link = a?.fields[1];
    const inverse = b?.fields.find((f) => f.name === 'As');
    expect(link?.options).toMatchObject({ linkedTableId: b?.id, inverseLinkFieldId: inverse?.id });
    expect(inverse?.options).toMatchObject({ linkedTableId: a?.id, inverseLinkFieldId: link?.id });
    expect(b?.fields[1]?.options).toEqual({ recordLinkFieldId: inverse?.id });
    expect(a?.records[0]?.cells[link?.id ?? '']).toEqual([b?.records[0]?.id]);
    expect(a?.views).toHaveLength(1);
  });

  it('refuses a cell of an unknown record or field', () => {
    const spec = (records: Record<string, unknown>[]) => ({
      slug: 'demo',
      name: 'Demo',
      description: '',
      category: 'Test',
      tables: [
        {
          key: 'a',
          name: 'A',
          fields: [
            { key: 'name', name: 'Name', type: 'singleLineText' as const },
            { key: 'self', name: 'Self', type: 'link' as const, table: 'a' },
          ],
          records,
        },
      ],
    });
    expect(() => defineTemplate(spec([{ name: 'x', self: ['y'] }]))).toThrow(/no a record y/);
    expect(() => defineTemplate(spec([{ nope: 1 }]))).toThrow(/no field nope/);
  });

  it('checks documents: one primary field, unique ids, known cells', () => {
    const base = JSON.parse(JSON.stringify(findTemplate('okrs')));
    expect(TemplateSchema.safeParse(base).success).toBe(true);
    const twoPrimaries = structuredClone(base);
    twoPrimaries.tables[0].fields[1].primary = true;
    expect(TemplateSchema.safeParse(twoPrimaries).success).toBe(false);
    const dup = structuredClone(base);
    dup.tables[1].id = dup.tables[0].id;
    expect(TemplateSchema.safeParse(dup).success).toBe(false);
    const stray = structuredClone(base);
    stray.tables[0].records[0].cells[stableUuid('stray')] = 'x';
    expect(TemplateSchema.safeParse(stray).success).toBe(false);
    const extra = { ...base, extra: true };
    expect(TemplateSchema.safeParse(extra).success).toBe(false);
  });
});

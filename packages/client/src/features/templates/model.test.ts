import { BUILT_IN_TEMPLATES, findTemplate, templateSummary } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { categoriesOf, inCategory, previewTable, templateStats } from './model';

const summaries = BUILT_IN_TEMPLATES.map(templateSummary);

describe('template gallery model', () => {
  it('lists each category once after All', () => {
    const categories = categoriesOf(summaries);
    expect(categories[0]).toBe('All');
    expect(new Set(categories).size).toBe(categories.length);
    expect(inCategory(summaries, 'All')).toHaveLength(summaries.length);
    expect(inCategory(summaries, 'Sales').map((t) => t.slug)).toEqual(['crm']);
  });

  it('counts tables and records', () => {
    const crm = summaries.find((t) => t.slug === 'crm');
    expect(crm && templateStats(crm)).toMatch(/^3 tables · \d+ records$/);
  });

  it('previews cells as text, links by name', () => {
    const crm = findTemplate('crm');
    if (!crm) throw new Error('no crm');
    const deals = previewTable(crm, 0, 2);
    expect(deals?.rows).toHaveLength(2);
    const byName = (name: string) => deals?.fields.find((f) => f.name === name)?.id ?? '';
    const first = deals?.rows[0]?.cells ?? {};
    expect(first[byName('Deal')]).toBe('Northwind annual plan');
    expect(first[byName('Stage')]).toBe('Negotiation');
    expect(first[byName('Company')]).toBe('Northwind Traders');
    expect(first[byName('Amount')]).toContain('48,000');
    expect(first[byName('Weighted amount')]).toBe('');
    expect(previewTable(crm, 9)).toBeNull();
  });
});

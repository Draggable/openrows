import type { FieldMeta } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import {
  aggregatesForField,
  arcPath,
  compactNumber,
  formatValue,
  keyLabel,
  labelStep,
  niceTicks,
  pieSlices,
  valueExtent,
} from './chart-model';

const field = (type: string, options: Record<string, unknown> = {}): FieldMeta =>
  ({
    id: '01900000-0000-7000-8000-000000000001',
    tableId: '01900000-0000-7000-8000-000000000002',
    name: 'F',
    type,
    options,
    isPrimary: false,
  }) as unknown as FieldMeta;

describe('dashboard chart model (#146)', () => {
  it('makes round ticks that cover the values', () => {
    expect(niceTicks(0, 37)).toEqual([0, 10, 20, 30, 40]);
    expect(niceTicks(0, 0)).toEqual([0, 1]);
    expect(niceTicks(-12, 30)).toEqual([-20, 0, 20, 40]);
    const t = niceTicks(0, 0.37);
    expect(t[0]).toBe(0);
    expect(t.at(-1)).toBeGreaterThanOrEqual(0.37);
  });

  it('measures stacks by their totals', () => {
    const data = {
      type: 'chart' as const,
      series: ['a', 'b'],
      rows: [
        { key: 'x', values: [3, 4] },
        { key: 'y', values: [5, null] },
      ],
      truncated: false,
      records: 12,
    };
    expect(valueExtent(data, true)).toEqual({ min: 0, max: 7 });
    expect(valueExtent(data, false)).toEqual({ min: 0, max: 5 });
  });

  it('cuts a pie in proportion and draws its arcs', () => {
    const slices = pieSlices([1, 3, null, -2]);
    expect(slices[0]).toEqual({ start: 0, end: Math.PI / 2 });
    expect(slices[1]?.end).toBeCloseTo(Math.PI * 2);
    expect(slices[2]?.end).toBe(slices[2]?.start);
    expect(arcPath(50, 50, 40, 0, 0, Math.PI / 2)).toBe(
      'M 50.00 10.00 A 40 40 0 0 1 90.00 50.00 L 50 50 Z'
    );
    // A whole circle is two arcs; a donut's segment closes on its inner radius.
    expect(arcPath(50, 50, 40, 0, 0, Math.PI * 2).match(/A /g)).toHaveLength(2);
    expect(arcPath(50, 50, 40, 20, 0, Math.PI / 2)).toContain('A 20 20 0 0 0');
  });

  it('labels groups and formats values as their field shows them', () => {
    const select = field('singleSelect', { choices: [{ id: 'c1', name: 'Open', color: 'green' }] });
    expect(keyLabel(select, 'c1')).toBe('Open');
    expect(keyLabel(select, null)).toBe('(Empty)');
    expect(keyLabel(select, 'x', true)).toBe('Other');
    expect(formatValue(1234, 'count', undefined)).toBe('1,234');
    expect(formatValue(null, 'sum', undefined)).toBe('–');
    expect(formatValue(12.5, 'sum', field('currency', { symbol: '$', precision: 2 }))).toContain(
      '12.50'
    );
    expect(compactNumber(1500)).toBe('1,500');
    expect(compactNumber(25_000)).toBe('25k');
    expect(compactNumber(3_400_000)).toBe('3.4M');
  });

  it('offers the aggregates the server allows per field type', () => {
    expect(aggregatesForField(undefined)).toEqual(['count']);
    expect(aggregatesForField(field('number'))).toContain('avg');
    expect(aggregatesForField(field('date'))).toEqual(['filled', 'empty', 'unique', 'min', 'max']);
    expect(aggregatesForField(field('singleLineText'))).toEqual(['filled', 'empty', 'unique']);
  });

  it('thins x labels so they do not collide', () => {
    expect(labelStep(5, 600)).toBe(1);
    expect(labelStep(50, 600)).toBe(6);
  });
});

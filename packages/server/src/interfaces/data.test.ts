import { MAX_CHART_GROUPS, MAX_CHART_SERIES } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { chartRows } from './data.js';

const bar = { chart: 'bar', fn: 'count', order: 'field' } as const;

describe('chartRows (#146)', () => {
  it('makes one row per group with a value per series, zeros for missing counts', () => {
    const groups = [
      { key: ['a', 'x'], value: 2 },
      { key: ['a', 'y'], value: 1 },
      { key: ['b', 'y'], value: 4 },
    ];
    expect(chartRows({ ...bar, chart: 'stackedBar' }, groups, ['x', 'y'])).toEqual({
      series: ['x', 'y'],
      rows: [
        { key: 'a', values: [2, 1] },
        { key: 'b', values: [0, 4] },
      ],
      truncated: false,
    });
    // Averages have no value where a series has no records.
    expect(chartRows({ ...bar, fn: 'avg' }, groups, ['x', 'y']).rows[1]).toEqual({
      key: 'b',
      values: [null, 4],
    });
  });

  it('orders by value when asked', () => {
    const groups = [
      { key: [null], value: 3 },
      { key: ['a'], value: 1 },
      { key: ['b'], value: 5 },
    ];
    const keys = (order: 'field' | 'valueDesc' | 'valueAsc') =>
      chartRows({ ...bar, order }, groups, null).rows.map((r) => r.key);
    expect(keys('field')).toEqual([null, 'a', 'b']);
    expect(keys('valueDesc')).toEqual(['b', null, 'a']);
    expect(keys('valueAsc')).toEqual(['a', null, 'b']);
  });

  it('caps series and groups; pies fold sums into Other but not averages', () => {
    const series = Array.from({ length: MAX_CHART_SERIES + 2 }, (_, i) => `s${i}`);
    const wide = chartRows(
      { ...bar, chart: 'line' },
      series.map((s) => ({ key: ['g', s], value: 1 })),
      series
    );
    expect(wide.series).toHaveLength(MAX_CHART_SERIES);
    expect(wide.rows[0]?.values).toHaveLength(MAX_CHART_SERIES);
    expect(wide.truncated).toBe(true);

    const many = Array.from({ length: MAX_CHART_GROUPS + 5 }, (_, i) => ({ key: [i], value: 2 }));
    expect(chartRows(bar, many, null)).toMatchObject({ truncated: true });
    expect(chartRows(bar, many, null).rows).toHaveLength(MAX_CHART_GROUPS);

    const pie = chartRows({ chart: 'pie', fn: 'sum', order: 'field' }, many, null);
    expect(pie.rows).toHaveLength(MAX_CHART_SERIES);
    expect(pie.rows.at(-1)).toEqual({
      key: null,
      values: [(many.length - (MAX_CHART_SERIES - 1)) * 2],
      other: true,
    });
    expect(pie.truncated).toBe(false);
    const avg = chartRows({ chart: 'donut', fn: 'avg', order: 'field' }, many, null);
    expect(avg.rows).toHaveLength(MAX_CHART_SERIES);
    expect(avg.truncated).toBe(true);
  });
});

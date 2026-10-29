import type { Aggregate, ChartElement, FieldMeta, InterfaceElementData } from '@openrows/shared';
import { cellText, fieldDef } from '../grid/cells/model';

/**
 * Dashboards: the charts' pure parts. Colours are the categorical slots `--chart-1` to
 * `--chart-6` (index.css: the Ledger green first, then hues validated for colour-blind
 * separation in both themes, in that fixed order); a single series is slot 1. "Other" is grey.
 */

export type ChartData = Extract<InterfaceElementData, { type: 'chart' }>;
export type ChartRow = ChartData['rows'][number];

export const seriesColor = (i: number) => `var(--chart-${(i % 6) + 1})`;
export const OTHER_COLOR = 'var(--chart-other)';

export const CHART_LABELS: Record<ChartElement['chart'], string> = {
  bar: 'Bar',
  stackedBar: 'Stacked bar',
  line: 'Line',
  pie: 'Pie',
  donut: 'Donut',
};

export const AGGREGATE_LABELS: Record<Aggregate, string> = {
  count: 'Count of records',
  sum: 'Sum',
  avg: 'Average',
  min: 'Minimum',
  max: 'Maximum',
  filled: 'Filled',
  empty: 'Empty',
  unique: 'Unique values',
};

/** Aggregates a number element offers for a field (the grid's summaries, as the server checks). */
export function aggregatesForField(field: FieldMeta | undefined): Aggregate[] {
  if (!field) return ['count'];
  if (field.type === 'link') return ['filled', 'empty'];
  const base: Aggregate[] = ['filled', 'empty', 'unique'];
  const { sort } = fieldDef(field).def;
  if (sort === 'number') return [...base, 'sum', 'avg', 'min', 'max'];
  if (sort === 'chronological') return [...base, 'min', 'max'];
  return base;
}

/** Fields a chart can sum, average and compare: numbers. */
export const isNumeric = (f: FieldMeta) => f.type !== 'link' && fieldDef(f).def.sort === 'number';

/** What a value means: a count is a whole number; an aggregate reads as its field shows it. */
export function formatValue(value: unknown, fn: Aggregate, field: FieldMeta | undefined): string {
  if (value === null || value === undefined) return '–';
  if (fn === 'count' || fn === 'filled' || fn === 'empty' || fn === 'unique' || !field) {
    return typeof value === 'number' ? value.toLocaleString('en') : String(value);
  }
  const text = cellText(field, value);
  if (text) return text;
  return typeof value === 'number' ? value.toLocaleString('en') : String(value);
}

/** Short axis labels: 1,200 → 1.2k, 3,400,000 → 3.4M. */
export function compactNumber(n: number): string {
  const abs = Math.abs(n);
  const fmt = (x: number, unit: string) => `${Number(x.toFixed(1)).toLocaleString('en')}${unit}`;
  if (abs >= 1e9) return fmt(n / 1e9, 'B');
  if (abs >= 1e6) return fmt(n / 1e6, 'M');
  if (abs >= 1e4) return fmt(n / 1e3, 'k');
  return Number(n.toFixed(2)).toLocaleString('en');
}

/** A group's or series' name: its cell text, "(Empty)" for no value, "Other" for the rest. */
export function keyLabel(field: FieldMeta | undefined, key: unknown, other = false): string {
  if (other) return 'Other';
  if (key === null || key === undefined) return '(Empty)';
  if (!field) return String(key);
  return cellText(field, key) || '(Empty)';
}

/** Round axis ticks from 0 (or below, for negatives) to past the extremes: 1, 2 or 5 × 10^n steps. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  if (hi === lo) return [0, 1];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const ticks: number[] = [];
  for (let v = Math.floor(lo / step) * step; v < hi + step / 2; v += step) {
    ticks.push(Number(v.toPrecision(12)));
    if (ticks.length > 20) break;
  }
  if ((ticks.at(-1) ?? 0) < hi) ticks.push(Number(((ticks.at(-1) ?? 0) + step).toPrecision(12)));
  return ticks;
}

/** The value range a chart plots: stacks add up, other charts take each value. */
export function valueExtent(data: ChartData, stacked: boolean): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (const row of data.rows) {
    if (stacked) {
      const pos = row.values.reduce<number>((a, v) => a + Math.max(0, v ?? 0), 0);
      const neg = row.values.reduce<number>((a, v) => a + Math.min(0, v ?? 0), 0);
      max = Math.max(max, pos);
      min = Math.min(min, neg);
    } else {
      for (const v of row.values) {
        if (v === null) continue;
        max = Math.max(max, v);
        min = Math.min(min, v);
      }
    }
  }
  return { min, max };
}

/** Pie slices as angles (radians, clockwise from 12 o'clock); non-positive values get none. */
export function pieSlices(values: readonly (number | null)[]): { start: number; end: number }[] {
  const total = values.reduce<number>((a, v) => a + Math.max(0, v ?? 0), 0);
  let at = 0;
  return values.map((v) => {
    const share = total > 0 ? Math.max(0, v ?? 0) / total : 0;
    const slice = { start: at, end: at + share * Math.PI * 2 };
    at = slice.end;
    return slice;
  });
}

const point = (cx: number, cy: number, r: number, a: number) =>
  `${(cx + r * Math.sin(a)).toFixed(2)} ${(cy - r * Math.cos(a)).toFixed(2)}`;

/** The SVG path of a slice; `inner` > 0 makes a donut's ring segment. */
export function arcPath(
  cx: number,
  cy: number,
  r: number,
  inner: number,
  start: number,
  end: number
): string {
  // A whole circle can't be one arc: two halves.
  if (end - start >= Math.PI * 2 - 1e-9) {
    const mid = start + Math.PI;
    return `${arcPath(cx, cy, r, inner, start, mid)} ${arcPath(cx, cy, r, inner, mid, end)}`;
  }
  const large = end - start > Math.PI ? 1 : 0;
  const outer = `M ${point(cx, cy, r, start)} A ${r} ${r} 0 ${large} 1 ${point(cx, cy, r, end)}`;
  if (inner <= 0) return `${outer} L ${cx} ${cy} Z`;
  return `${outer} L ${point(cx, cy, inner, end)} A ${inner} ${inner} 0 ${large} 0 ${point(cx, cy, inner, start)} Z`;
}

/** Every `step`-th x label shows, so labels at least `minGap` px apart don't collide. */
export const labelStep = (count: number, width: number, minGap = 64) =>
  Math.max(1, Math.ceil((count * minGap) / Math.max(1, width)));

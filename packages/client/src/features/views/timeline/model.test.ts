import type { FieldMeta, RecordData } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { eventsOf } from '../calendar/model';
import {
  barBox,
  dependenciesOf,
  dependencyPath,
  rowsOf,
  SCALES,
  selfLinksOf,
  startResizePatch,
  ticksOf,
  timelinePair,
  titlePlacement,
  windowOf,
} from './model';

const field = (id: string, type: string, options: unknown = {}): FieldMeta =>
  ({
    id,
    tableId: 't',
    name: id,
    type,
    options,
    description: null,
    isPrimary: false,
    position: 1,
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }) as unknown as FieldMeta;

const start = field('start', 'date');
const end = field('end', 'date');
const stage = field('stage', 'singleSelect', {
  choices: [
    { id: 'a', name: 'A', color: 'red' },
    { id: 'b', name: 'B', color: 'blue' },
  ],
});
const deps = field('deps', 'link', { linkedTableId: 't' });
const other = field('other', 'link', { linkedTableId: 'x' });
const record = (id: string, fields: Record<string, unknown>): RecordData =>
  ({ id, tableId: 't', version: 1, fields }) as unknown as RecordData;
const isDate = (f: FieldMeta) => f.type === 'date';
const pair = timelinePair([start, end], { startFieldId: 'start', endFieldId: 'end' }, isDate);

describe('timeline windows', () => {
  it('keeps every window under the query limit of 400 days', () => {
    for (const s of Object.values(SCALES)) expect(s.days).toBeLessThanOrEqual(400);
    // Wednesday March 18, 2026: the day scale starts a week before its Sunday.
    expect(windowOf('day', '2026-03-18')).toEqual({ from: '2026-03-08', to: '2026-04-18' });
    expect(windowOf('week', '2026-03-18').from).toBe('2026-02-15');
    expect(windowOf('month', '2026-03-18').from).toBe('2026-01-01');
  });

  it('labels months over days, and years over months', () => {
    const day = ticksOf('day', '2026-02-27', 4);
    expect(day.top.map((t) => t.label)).toEqual(['Feb 2026', 'Mar 2026']);
    expect(day.bottom.map((t) => t.label)).toEqual(['27', '28', '1', '2']);
    const month = ticksOf('month', '2025-12-01', 40);
    expect(month.top.map((t) => t.label)).toEqual(['2025', '2026']);
    expect(month.bottom.map((t) => t.label)).toEqual(['Dec', 'Jan']);
    expect(ticksOf('week', '2026-03-01', 14).bottom.map((t) => t.label)).toEqual([
      'Mar 1',
      'Mar 8',
    ]);
  });

  it('clips bars to the window', () => {
    expect(barBox({ start: '2026-03-02', end: '2026-03-04' }, '2026-03-01', 10, 10)).toEqual({
      left: 10,
      width: 30,
      clippedStart: false,
      clippedEnd: false,
    });
    expect(barBox({ start: '2026-02-20', end: '2026-03-01' }, '2026-03-01', 10, 10)).toMatchObject({
      left: 0,
      width: 10,
      clippedStart: true,
    });
    expect(barBox({ start: '2026-04-01', end: '2026-04-01' }, '2026-03-01', 10, 10)).toBeNull();
  });
});

describe('timeline rows', () => {
  it('needs a live date start field', () => {
    expect(timelinePair([start], {}, isDate)).toBeNull();
    expect(timelinePair([stage], { startFieldId: 'stage' }, isDate)).toBeNull();
    expect(pair?.end?.id).toBe('end');
  });

  it('groups bars under the choices in order, empty group first', () => {
    if (!pair) throw new Error('no pair');
    const rows = rowsOf(
      [
        record('r1', { start: '2026-03-05', stage: 'b' }),
        record('r2', { start: '2026-03-01', stage: null }),
        record('r3', { start: '2026-03-02', stage: 'b' }),
      ],
      pair,
      undefined,
      stage
    );
    expect(rows.map((r) => (r.kind === 'group' ? `#${r.label}` : r.event.record.id))).toEqual([
      '#Uncategorized',
      'r2',
      '#B',
      'r3',
      'r1',
    ]);
  });

  it('resizes from the start, never past the end', () => {
    if (!pair) throw new Error('no pair');
    const [event] = eventsOf(
      [record('r', { start: '2026-03-02', end: '2026-03-05' })],
      [pair],
      undefined
    );
    if (!event) throw new Error('no event');
    expect(startResizePatch(event, '2026-02-28')).toEqual({ start: '2026-02-28' });
    expect(startResizePatch(event, '2026-03-09')).toEqual({ start: '2026-03-05' });
    expect(startResizePatch(event, '2026-03-02')).toBeNull();
  });
});

describe('Gantt dependencies', () => {
  it('offers links to the same table only', () => {
    expect(selfLinksOf([deps, other, start], 't').map((f) => f.id)).toEqual(['deps']);
  });

  it('draws an arrow per visible dependency and flags the ones that overlap', () => {
    if (!pair) throw new Error('no pair');
    const events = eventsOf(
      [
        record('a', { start: '2026-03-01', end: '2026-03-03' }),
        record('b', { start: '2026-03-04', deps: [{ id: 'a' }] }),
        record('c', { start: '2026-03-02', deps: [{ id: 'a' }, { id: 'gone' }, { id: 'c' }] }),
      ],
      [pair],
      undefined
    );
    expect(dependenciesOf(events, deps)).toEqual([
      { from: 'a', to: 'c', conflict: true },
      { from: 'a', to: 'b', conflict: false },
    ]);
    expect(dependenciesOf(events, undefined)).toEqual([]);
  });
});

describe('dependency paths (#83)', () => {
  // A path's points as [x, y] pairs, for bounds checks.
  const xs = (d: string) => [...d.matchAll(/[ML](-?[\d.]+),/g)].map((m) => Number(m[1]));

  it('draws the whole path when both ends are visible', () => {
    expect(dependencyPath(100, 17, 200, 51, 0, 1000)).toEqual({
      d: 'M100,17 L108,17 L108,51 L200,51',
      arrow: true,
    });
    // Around the bar's start when it starts before the other ends.
    expect(dependencyPath(100, 17, 96, 51, 0, 1000)?.d).toBe(
      'M100,17 L108,17 L108,34 L88,34 L88,51 L96,51'
    );
  });

  it('draws nothing when both ends are outside the visible part', () => {
    // Both scrolled under the label column (left of minX).
    expect(dependencyPath(40, 17, 80, 51, 300, 1000)).toBeNull();
    // Both past the window's end, or one on each side.
    expect(dependencyPath(1100, 17, 1200, 51, 0, 1000)).toBeNull();
    expect(dependencyPath(-50, 17, 1200, 51, 0, 1000)).toBeNull();
  });

  it('clips a path with one end hidden to the visible part, never left of minX', () => {
    const into = dependencyPath(250, 17, 400, 51, 300, 1000);
    expect(into?.arrow).toBe(true);
    expect(Math.min(...xs(into?.d ?? ''))).toBeGreaterThanOrEqual(300);
    expect(into?.d).toBe('M300,51 L400,51');
    // The end hidden: no arrow head, and the rest stays right of minX.
    const out = dependencyPath(400, 17, 380, 51, 390, 1000);
    expect(out?.arrow).toBe(false);
    expect(Math.min(...xs(out?.d ?? ''))).toBeGreaterThanOrEqual(390);
    // An end right at the edge: its head would cross it.
    expect(dependencyPath(250, 17, 302, 51, 300, 1000)?.arrow).toBe(false);
  });
});

describe('bar titles (#83)', () => {
  it('puts a title that does not fit to the right of its bar, room permitting', () => {
    expect(titlePlacement('Record 17', { left: 0, width: 132 }, 1000)).toBe('inside');
    expect(titlePlacement('Record 17', { left: 0, width: 44 }, 1000)).toBe('outside');
    // At the window's end there is no room outside: truncated inside.
    expect(titlePlacement('Record 17', { left: 956, width: 44 }, 1000)).toBe('inside');
  });
});

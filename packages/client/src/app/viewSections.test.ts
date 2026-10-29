import type { ViewMeta, ViewSection } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { dropTarget, sectionDropPosition, sidebarGroups, viewGroups } from './viewSections';

const view = (id: string, position: number, sectionId: string | null = null) =>
  ({ id, name: id, position, sectionId }) as ViewMeta;
const section = (id: string, position: number) =>
  ({ id, name: id, position, tableId: 't' }) as ViewSection;

describe('view sections in the sidebar (#42)', () => {
  const sections = [section('s2', 2), section('s1', 1)];
  const views = [view('a', 3), view('b', 1), view('c', 2, 's1'), view('d', 1, 'gone')];

  it('groups views outside sections first, then by section, each in order', () => {
    expect(
      viewGroups(views, sections).map((g) => [g.section?.id ?? null, g.views.map((v) => v.id)])
    ).toEqual([
      [null, ['b', 'd', 'a']],
      ['s1', ['c']],
      ['s2', []],
    ]);
  });

  it('places a dropped view before its target, in the target group', () => {
    const [outside, s1, s2] = viewGroups(views, sections);
    if (!outside || !s1 || !s2) throw new Error('groups');
    // b (1), d (1), a (3): before a, after d.
    expect(dropTarget(outside, 'c', view('a', 3))).toEqual({ position: 2, sectionId: null });
    expect(dropTarget(outside, 'c', null)).toEqual({ position: 4, sectionId: null });
    expect(dropTarget(s1, 'a', view('c', 2, 's1'))).toEqual({ position: 1, sectionId: 's1' });
    expect(dropTarget(s2, 'a', null)).toEqual({ position: 1, sectionId: 's2' });
    // Dropping a view before itself keeps its neighbours.
    expect(dropTarget(outside, 'a', view('a', 3)).position).toBe(2);
  });

  it('reorders sections by drop target', () => {
    expect(sectionDropPosition(sections, 's2', section('s1', 1))).toBe(0);
    expect(sectionDropPosition(sections, 's1', null)).toBe(3);
  });
});

describe('personal views apart in the sidebar (#83)', () => {
  const sections = [section('s1', 1), section('s2', 2)];
  const shared = (id: string, position: number, sectionId: string | null = null) =>
    ({ ...view(id, position, sectionId), personal: false }) as ViewMeta;
  const mine = (id: string, position: number, sectionId: string | null = null) =>
    ({ ...view(id, position, sectionId), personal: true }) as ViewMeta;
  const views = [
    shared('a', 1),
    mine('m1', 2),
    shared('b', 3, 's1'),
    mine('m2', 1, 's1'),
    mine('m3', 4),
  ];
  const ids = (groups: ReturnType<typeof viewGroups>) =>
    groups.map((g) => [g.section?.id ?? null, g.views.map((v) => v.id)]);

  it('lists collaborative views by section, every section shown', () => {
    expect(ids(sidebarGroups(views, sections).shared)).toEqual([
      [null, ['a']],
      ['s1', ['b']],
      ['s2', []],
    ]);
  });

  it('lists personal views under My views, by the sections that hold one', () => {
    expect(ids(sidebarGroups(views, sections).mine)).toEqual([
      [null, ['m1', 'm3']],
      ['s1', ['m2']],
    ]);
    expect(sidebarGroups([shared('a', 1)], sections).mine).toEqual([]);
  });
});

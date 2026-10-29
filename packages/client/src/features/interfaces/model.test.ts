import type { FieldMeta, InterfaceElement, InterfacePageConfig } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import {
  cellsMoved,
  dataFilters,
  elementConditions,
  elementTypesFor,
  moveElement,
  newElement,
  nextRow,
  pageFieldIds,
  publishState,
  readingOrder,
  resizeElement,
  visibleConfig,
} from './model';

const field = (id: string, type: string, extra: Partial<FieldMeta> = {}) =>
  ({ id, name: id, type, isPrimary: false, options: {}, ...extra }) as FieldMeta;
const FIELDS = [
  field('name', 'singleLineText', { isPrimary: true }),
  field('status', 'singleSelect'),
  field('done', 'checkbox'),
  field('count', 'number'),
];
const text = (id: string, x: number, y: number, w = 4, h = 1): InterfaceElement => ({
  id,
  type: 'text',
  x,
  y,
  w,
  h,
  content: '',
});
const config = (elements: InterfaceElement[] = []): InterfacePageConfig => ({
  layout: 'recordReview',
  tableId: 't',
  sorts: [],
  fields: ['count', 'gone'],
  elements,
});

describe('interface designer model (#145)', () => {
  it('adds elements below the others, with unique ids, on a suitable field', () => {
    const els = [text('text-1', 0, 0, 12, 2)];
    expect(nextRow(els)).toBe(2);
    expect(newElement('text', els, FIELDS)).toMatchObject({ id: 'text-2', y: 2, x: 0 });
    expect(newElement('filter', els, FIELDS)).toMatchObject({ fieldId: 'name' });
    expect(newElement('field', els, FIELDS)).toMatchObject({ fieldId: 'status' });
    expect(newElement('filter', [], [field('count', 'number')])).toBeNull();
    // Numbers count the page table's records; charts group by its first single select.
    expect(newElement('number', els, FIELDS, 'tbl')).toMatchObject({
      tableId: 'tbl',
      fn: 'count',
      fieldId: null,
    });
    expect(newElement('chart', els, FIELDS, 'tbl')).toMatchObject({
      tableId: 'tbl',
      chart: 'bar',
      groupFieldId: 'status',
      w: 6,
      h: 6,
    });
    expect(dataFilters({ a: 'x', b: '', c: true, d: false, e: null })).toEqual({ a: 'x', c: true });
  });

  it('moves and resizes inside the grid', () => {
    const el = text('a', 10, 0, 2, 1);
    expect(moveElement(el, 5, -3)).toMatchObject({ x: 10, y: 0 });
    expect(moveElement(el, -4, 2)).toMatchObject({ x: 6, y: 2 });
    expect(resizeElement(el, 3, 0)).toMatchObject({ w: 2 });
    expect(resizeElement(el, -5, 2)).toMatchObject({ w: 1, h: 3 });
    expect(cellsMoved(130, 60)).toBe(2);
    expect(cellsMoved(-20, 60)).toBe(-0);
    expect(cellsMoved(10, 0)).toBe(0);
    expect(
      readingOrder([text('b', 4, 1), text('a', 0, 1), text('c', 0, 0)]).map((e) => e.id)
    ).toEqual(['c', 'a', 'b']);
  });

  it('keeps record elements to record review pages', () => {
    expect(elementTypesFor('recordList')).toEqual(['text', 'filter', 'button', 'number', 'chart']);
    expect(elementTypesFor('dashboard')).toEqual(['text', 'filter', 'button', 'number', 'chart']);
    expect(elementTypesFor('recordReview')).toEqual([
      'text',
      'filter',
      'button',
      'field',
      'number',
      'chart',
    ]);
  });

  it("turns the viewer's filters into conditions, skipping blank ones", () => {
    const c = config([
      { id: 's', type: 'filter', x: 0, y: 0, w: 4, h: 1, fieldId: 'status', label: '' },
      { id: 'n', type: 'filter', x: 4, y: 0, w: 4, h: 1, fieldId: 'name', label: '' },
      { id: 'd', type: 'filter', x: 8, y: 0, w: 4, h: 1, fieldId: 'done', label: '' },
    ]);
    expect(elementConditions(c, { s: 'open', n: '', d: false }, FIELDS)).toEqual([
      { fieldId: 'status', operator: 'is', value: 'open' },
    ]);
    expect(elementConditions(c, { n: 'abc', d: true }, FIELDS)).toEqual([
      { fieldId: 'name', operator: 'contains', value: 'abc' },
      { fieldId: 'done', operator: 'is', value: true },
    ]);
  });

  it('asks for the primary, list and element fields that still exist', () => {
    const c = config([
      { id: 'f', type: 'field', x: 0, y: 0, w: 4, h: 1, fieldId: 'done', editable: true },
    ]);
    expect(pageFieldIds(c, FIELDS)).toEqual(['name', 'count', 'done']);
  });

  it('shows editors the draft and everyone else the published copy', () => {
    const draft = config();
    const published = { ...config(), fields: [] };
    const page = {
      id: 'p',
      interfaceId: 'i',
      name: 'P',
      position: 1,
      draft,
      published,
      publishedAt: '2026-10-28T00:00:00Z',
      hasChanges: true,
    };
    expect(visibleConfig(page, true)).toBe(draft);
    expect(visibleConfig({ ...page, draft: null }, false)).toBe(published);
    expect(publishState(page)).toBe('changes');
    expect(publishState({ ...page, hasChanges: false })).toBe('published');
    expect(publishState({ ...page, published: null })).toBe('never');
  });
});

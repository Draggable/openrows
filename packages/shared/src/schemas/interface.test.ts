import { describe, expect, it } from 'vitest';
import {
  filterElementConditions,
  filterElementOperator,
  INTERFACE_GRID_COLUMNS,
  interfacePageConfigSchema,
  interfacePageDataQuerySchema,
  MAX_DATA_ELEMENTS,
  MAX_ELEMENTS_PER_PAGE,
  MAX_FILTER_ELEMENTS,
} from './interface.js';

const TABLE = '01900000-0000-7000-8000-000000000001';
const FIELD = '01900000-0000-7000-8000-000000000002';
const at = { x: 0, y: 0, w: 4, h: 1 };

describe('interface page config (#145)', () => {
  it('defaults an empty page', () => {
    expect(interfacePageConfigSchema.parse({ layout: 'recordList', tableId: TABLE })).toEqual({
      layout: 'recordList',
      tableId: TABLE,
      sorts: [],
      fields: [],
      elements: [],
    });
  });

  it('takes every element type on a record review page', () => {
    const parsed = interfacePageConfigSchema.parse({
      layout: 'recordReview',
      tableId: TABLE,
      elements: [
        { ...at, id: 't', type: 'text', content: '**Hi**' },
        { ...at, id: 'f', type: 'filter', fieldId: FIELD },
        { ...at, id: 'b', type: 'button', action: { type: 'openUrl', url: 'https://x.test/a' } },
        {
          ...at,
          id: 'r',
          type: 'button',
          label: 'Go',
          action: { type: 'runAutomation', fieldId: FIELD },
        },
        { ...at, id: 'd', type: 'field', fieldId: FIELD },
      ],
    });
    expect(parsed.elements.map((e) => e.type)).toEqual([
      'text',
      'filter',
      'button',
      'button',
      'field',
    ]);
    expect(parsed.elements[2]).toMatchObject({ label: 'Open' });
    expect(parsed.elements[4]).toMatchObject({ editable: false });
  });

  const problems = (config: unknown) => {
    const r = interfacePageConfigSchema.safeParse(config);
    return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
  };

  it('refuses record elements on a record list, overflowing and duplicate elements', () => {
    expect(
      problems({
        layout: 'recordList',
        tableId: TABLE,
        elements: [
          { ...at, id: 'd', type: 'field', fieldId: FIELD },
          {
            ...at,
            id: 'r',
            type: 'button',
            label: 'Go',
            action: { type: 'runAutomation', fieldId: FIELD },
          },
          { ...at, id: 'w', type: 'text', x: INTERFACE_GRID_COLUMNS - 2, w: 4 },
          { ...at, id: 'w', type: 'text' },
        ],
      })
    ).toEqual(['elements.0.type', 'elements.1.type', 'elements.2.w', 'elements.3.id']);
  });

  it('refuses unsafe URLs, bad ids and too many elements or filters', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'not a url']) {
      expect(
        problems({
          layout: 'recordList',
          tableId: TABLE,
          elements: [{ ...at, id: 'b', type: 'button', action: { type: 'openUrl', url } }],
        })
      ).toEqual(['elements.0.action.url']);
    }
    expect(
      problems({
        layout: 'recordList',
        tableId: TABLE,
        elements: [{ ...at, id: '<x>', type: 'text' }],
      })
    ).toEqual(['elements.0.id']);
    const many = Array.from({ length: MAX_ELEMENTS_PER_PAGE + 1 }, (_, i) => ({
      ...at,
      id: `t${i}`,
      type: 'text',
    }));
    expect(problems({ layout: 'recordList', tableId: TABLE, elements: many })).toEqual([
      'elements',
    ]);
    const filters = Array.from({ length: MAX_FILTER_ELEMENTS + 1 }, (_, i) => ({
      ...at,
      id: `f${i}`,
      type: 'filter',
      fieldId: FIELD,
    }));
    expect(problems({ layout: 'recordList', tableId: TABLE, elements: filters })).toEqual([
      'elements',
    ]);
  });

  it('picks the operator a filter element uses', () => {
    expect(filterElementOperator('singleSelect')).toBe('is');
    expect(filterElementOperator('checkbox')).toBe('is');
    expect(filterElementOperator('singleLineText')).toBe('contains');
    expect(filterElementOperator('number')).toBeNull();
    expect(filterElementOperator('nope')).toBeNull();
  });

  describe('dashboards (#146)', () => {
    const OTHER = '01900000-0000-7000-8000-000000000003';
    it('defaults number and chart elements', () => {
      const parsed = interfacePageConfigSchema.parse({
        layout: 'dashboard',
        tableId: TABLE,
        elements: [
          { ...at, id: 'n', type: 'number', tableId: TABLE },
          { ...at, id: 'c', type: 'chart', tableId: TABLE, groupFieldId: FIELD },
        ],
      });
      expect(parsed.elements).toEqual([
        {
          ...at,
          id: 'n',
          type: 'number',
          tableId: TABLE,
          label: '',
          viewId: null,
          fieldId: null,
          fn: 'count',
        },
        {
          ...at,
          id: 'c',
          type: 'chart',
          tableId: TABLE,
          label: '',
          viewId: null,
          chart: 'bar',
          groupFieldId: FIELD,
          seriesFieldId: null,
          fieldId: null,
          fn: 'count',
          order: 'field',
        },
      ]);
    });

    it('refuses incomplete summaries and record elements on a dashboard', () => {
      const page = (elements: unknown[]) => ({ layout: 'dashboard', tableId: TABLE, elements });
      expect(
        problems(page([{ ...at, id: 'n', type: 'number', tableId: TABLE, fn: 'sum' }]))
      ).toEqual(['elements.0.fieldId']);
      const chart = { ...at, id: 'c', type: 'chart', tableId: TABLE, groupFieldId: FIELD };
      expect(problems(page([{ ...chart, chart: 'stackedBar' }]))).toEqual([
        'elements.0.seriesFieldId',
      ]);
      expect(problems(page([{ ...chart, chart: 'pie', seriesFieldId: OTHER }]))).toEqual([
        'elements.0.seriesFieldId',
      ]);
      expect(problems(page([{ ...chart, chart: 'line', seriesFieldId: FIELD }]))).toEqual([
        'elements.0.seriesFieldId',
      ]);
      expect(problems(page([{ ...chart, chart: 'radar' }]))).toEqual(['elements.0.chart']);
      expect(problems(page([{ ...at, id: 'd', type: 'field', fieldId: FIELD }]))).toEqual([
        'elements.0.type',
      ]);
      const many = Array.from({ length: MAX_DATA_ELEMENTS + 1 }, (_, i) => ({
        ...at,
        id: `n${i}`,
        type: 'number',
        tableId: TABLE,
      }));
      expect(problems(page(many))).toEqual(['elements']);
    });

    it("builds the viewer's filter conditions and caps the data request", () => {
      const fields = [
        { id: FIELD, type: 'singleSelect' },
        { id: OTHER, type: 'singleLineText' },
      ];
      const elements = interfacePageConfigSchema.parse({
        layout: 'dashboard',
        tableId: TABLE,
        elements: [
          { ...at, id: 'a', type: 'filter', fieldId: FIELD },
          { ...at, id: 'b', type: 'filter', fieldId: OTHER },
        ],
      }).elements;
      expect(filterElementConditions(elements, { a: 'open', b: '' }, fields)).toEqual([
        { fieldId: FIELD, operator: 'is', value: 'open' },
      ]);
      expect(interfacePageDataQuerySchema.parse({})).toEqual({ draft: false, filters: {} });
      const tooMany = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}`, 'x']));
      expect(interfacePageDataQuerySchema.safeParse({ filters: tooMany }).success).toBe(false);
      expect(interfacePageDataQuerySchema.safeParse({ filters: { a: { $ne: 1 } } }).success).toBe(
        false
      );
    });
  });
});

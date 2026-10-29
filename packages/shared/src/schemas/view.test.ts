import { describe, expect, it } from 'vitest';
import {
  fitsTimelineKey,
  gridLayoutFieldRefs,
  isSelfLinkField,
  isStackableField,
  kanbanLayoutFieldRefs,
  moveViewRecordSchema,
  pruneGalleryLayout,
  pruneGridLayout,
  pruneKanbanLayout,
  pruneListLayout,
  pruneTimelineLayout,
  updateViewSchema,
  ViewSchema,
  viewConfigOf,
  viewConfigSchema,
} from './view.js';

const NAME = '00000000-0000-4000-8000-000000000001';
const NOTES = '00000000-0000-4000-8000-000000000002';
const GONE = '00000000-0000-4000-8000-000000000003';
const fields = [
  { id: NAME, type: 'singleLineText', isPrimary: true },
  { id: NOTES, type: 'longText' },
];

describe('view config (#21)', () => {
  it('refuses unknown keys on write, in the layout, the query and beside them', () => {
    expect(updateViewSchema.safeParse({ grid: { frozenCount: 1 } }).success).toBe(true);
    expect(updateViewSchema.safeParse({ grid: { colour: 'red' } }).success).toBe(false);
    expect(updateViewSchema.safeParse({ query: { sql: 'x' } }).success).toBe(false);
    expect(updateViewSchema.safeParse({ config: {} }).success).toBe(false);
    expect(updateViewSchema.safeParse({ grid: { fieldOrder: ['nope'] } }).success).toBe(false);
    expect(updateViewSchema.safeParse({ grid: { frozenCount: 11 } }).success).toBe(false);
  });

  it('names every field id of a layout with its path', () => {
    expect(
      gridLayoutFieldRefs({
        fieldOrder: [NOTES],
        columnWidths: { [NAME]: 100 },
        hiddenFields: [NOTES],
      })
    ).toEqual([
      { path: 'fieldOrder.0', id: NOTES },
      { path: `columnWidths.${NAME}`, id: NAME },
      { path: 'hiddenFields.0', id: NOTES },
    ]);
  });

  it('prunes fields that are gone and never hides the primary field', () => {
    expect(
      pruneGridLayout(
        {
          fieldOrder: [GONE, NOTES, NAME],
          columnWidths: { [GONE]: 100, [NOTES]: 200 },
          hiddenFields: [NAME, GONE, NOTES],
          rowHeight: 'tall',
        },
        fields
      )
    ).toEqual({
      fieldOrder: [NOTES, NAME],
      columnWidths: { [NOTES]: 200 },
      hiddenFields: [NOTES],
      rowHeight: 'tall',
    });
  });

  it('reads a stored config into the typed shape, pruned, dropping what it cannot read', () => {
    const stored = {
      sorts: [
        { fieldId: GONE, direction: 'asc' },
        { fieldId: NOTES, direction: 'desc' },
      ],
      grid: { hiddenFields: [GONE], frozenCount: 2 },
      visibleFields: [NAME],
    };
    const config = viewConfigOf(stored, fields);
    expect(config).toEqual({
      sorts: [{ fieldId: NOTES, direction: 'desc' }],
      grid: { hiddenFields: [], frozenCount: 2 },
    });
    expect(viewConfigSchema.parse(config)).toEqual(config);
    expect(viewConfigOf({ grid: { frozenCount: 'x' }, sorts: 'bad' }, fields)).toEqual({
      grid: {},
    });
    expect(viewConfigOf(undefined, fields)).toEqual({});
  });

  it('types the config of a view response', () => {
    const view = {
      id: NAME,
      tableId: NOTES,
      name: 'Grid view',
      type: 'grid',
      position: 0,
      config: {},
      personal: false,
      locked: false,
      sectionId: null,
      createdBy: null,
      createdAt: '2026-10-26T00:00:00.000Z',
      updatedAt: '2026-10-26T00:00:00.000Z',
    };
    expect(ViewSchema.safeParse(view).success).toBe(true);
    expect(ViewSchema.safeParse({ ...view, config: { grid: { colour: 1 } } }).success).toBe(false);
  });
});

describe('kanban layout (#39)', () => {
  const STATUS = '00000000-0000-4000-8000-000000000004';
  const OWNER = '00000000-0000-4000-8000-000000000005';
  const FILES = '00000000-0000-4000-8000-000000000006';
  const board = [
    ...fields,
    { id: STATUS, type: 'singleSelect', options: { choices: [] } },
    { id: OWNER, type: 'user', options: { multiple: false } },
    { id: FILES, type: 'attachment', options: {} },
  ];

  it('is strict on write', () => {
    expect(updateViewSchema.safeParse({ kanban: { stackFieldId: STATUS } }).success).toBe(true);
    expect(updateViewSchema.safeParse({ kanban: { stackFieldId: null } }).success).toBe(true);
    expect(updateViewSchema.safeParse({ kanban: { stackBy: STATUS } }).success).toBe(false);
    expect(updateViewSchema.safeParse({ kanban: { stackFieldId: 'x' } }).success).toBe(false);
    expect(updateViewSchema.safeParse({ kanban: { collapseEmpty: 'yes' } }).success).toBe(false);
  });

  it('stacks by single selects and one-person user fields only', () => {
    expect(isStackableField({ type: 'singleSelect' })).toBe(true);
    expect(isStackableField({ type: 'user', options: { multiple: false } })).toBe(true);
    expect(isStackableField({ type: 'user', options: {} })).toBe(true);
    expect(isStackableField({ type: 'user', options: { multiple: true } })).toBe(false);
    expect(isStackableField({ type: 'multipleSelect' })).toBe(false);
    expect(isStackableField({ type: 'singleLineText' })).toBe(false);
  });

  it('names its field ids with paths and prunes the ones that no longer fit', () => {
    const layout = { stackFieldId: STATUS, cardFields: [NOTES, GONE], coverFieldId: FILES };
    expect(kanbanLayoutFieldRefs(layout)).toEqual([
      { path: 'stackFieldId', id: STATUS },
      { path: 'cardFields.0', id: NOTES },
      { path: 'cardFields.1', id: GONE },
      { path: 'coverFieldId', id: FILES },
    ]);
    expect(pruneKanbanLayout(layout, board)).toEqual({ ...layout, cardFields: [NOTES] });
    const converted = board.map((f) =>
      f.id === STATUS
        ? { ...f, type: 'multipleSelect' }
        : f.id === FILES
          ? { ...f, type: 'url' }
          : f
    );
    expect(pruneKanbanLayout(layout, converted)).toMatchObject({
      stackFieldId: null,
      coverFieldId: null,
    });
    expect(viewConfigOf({ kanban: { stackFieldId: GONE } }, board)).toEqual({
      kanban: { stackFieldId: null },
    });
    // An unreadable stored layout reads as empty.
    expect(viewConfigOf({ kanban: { stackFieldId: 7 } }, board)).toEqual({ kanban: {} });
  });

  it('moves a record after another, never after itself', () => {
    expect(moveViewRecordSchema.safeParse({ recordId: NAME, afterId: null }).success).toBe(true);
    expect(moveViewRecordSchema.safeParse({ recordId: NAME, afterId: NOTES }).success).toBe(true);
    expect(moveViewRecordSchema.safeParse({ recordId: NAME, afterId: NAME }).success).toBe(false);
    expect(moveViewRecordSchema.safeParse({ recordId: NAME }).success).toBe(false);
  });
});

describe('gallery, timeline and list layouts (#41)', () => {
  const TABLE = '00000000-0000-4000-8000-0000000000aa';
  const START = '00000000-0000-4000-8000-000000000011';
  const STAGE = '00000000-0000-4000-8000-000000000012';
  const PHOTOS = '00000000-0000-4000-8000-000000000013';
  const PARENT = '00000000-0000-4000-8000-000000000014';
  const live = [
    ...fields,
    { id: START, type: 'date' },
    { id: STAGE, type: 'singleSelect' },
    { id: PHOTOS, type: 'attachment' },
    { id: PARENT, type: 'link', options: { linkedTableId: TABLE } },
  ];

  it('refuses unknown keys and values on write', () => {
    expect(updateViewSchema.safeParse({ gallery: { cardSize: 'large' } }).success).toBe(true);
    expect(updateViewSchema.safeParse({ gallery: { cardSize: 'xl' } }).success).toBe(false);
    expect(updateViewSchema.safeParse({ timeline: { scale: 'quarter' } }).success).toBe(false);
    expect(updateViewSchema.safeParse({ timeline: { zoom: 1 } }).success).toBe(false);
    expect(updateViewSchema.safeParse({ list: { parentFieldId: 'x' } }).success).toBe(false);
  });

  it('tells self links from links to other tables', () => {
    expect(isSelfLinkField({ type: 'link', options: { linkedTableId: TABLE } }, TABLE)).toBe(true);
    expect(isSelfLinkField({ type: 'link', options: { linkedTableId: NAME } }, TABLE)).toBe(false);
    expect(isSelfLinkField({ type: 'date' }, TABLE)).toBe(false);
    expect(fitsTimelineKey('startFieldId', { type: 'dateTime' })).toBe(true);
    expect(fitsTimelineKey('groupFieldId', { type: 'date' })).toBe(false);
  });

  it('prunes fields that are gone or no longer fit', () => {
    expect(
      viewConfigOf(
        {
          gallery: { cardFields: [GONE, STAGE], coverFieldId: STAGE },
          timeline: { startFieldId: START, endFieldId: GONE, groupFieldId: PHOTOS, scale: 'week' },
          list: { parentFieldId: START, rowFields: [GONE, STAGE] },
        },
        live
      )
    ).toMatchObject({
      gallery: { cardFields: [STAGE], coverFieldId: null },
      timeline: { startFieldId: START, endFieldId: null, groupFieldId: null, scale: 'week' },
      list: { parentFieldId: null, rowFields: [STAGE] },
    });
    expect(pruneTimelineLayout({ dependencyFieldId: PARENT }, live)).toEqual({
      dependencyFieldId: PARENT,
    });
    expect(pruneListLayout({ parentFieldId: PARENT }, live)).toEqual({ parentFieldId: PARENT });
    expect(pruneGalleryLayout({ coverFieldId: PHOTOS }, live)).toEqual({ coverFieldId: PHOTOS });
  });
});

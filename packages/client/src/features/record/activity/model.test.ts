import type { Comment, FieldMeta, Revision } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { activityItems, isEmptyValue, plainValue, revisionVerb, sameType } from './model';

const REC = '0190a000-0000-7000-8000-000000000002';
const F1 = '0190a000-0000-7000-8000-0000000000f1';
const F2 = '0190a000-0000-7000-8000-0000000000f2';
const F3 = '0190a000-0000-7000-8000-0000000000f3';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 26, 10, minute)).toISOString();

const revision = (n: number, minute: number, extra: Partial<Revision> = {}): Revision => ({
  id: `0190a000-0000-7000-8000-0000000000e${n}`,
  recordId: REC,
  kind: 'updated',
  actorId: null,
  at: at(minute),
  changes: [{ fieldId: F1, type: 'singleLineText', before: 'a', after: 'b' }],
  restoredFrom: null,
  via: null,
  ...extra,
});

const comment = (n: number, minute: number): Comment => ({
  id: `0190a000-0000-7000-8000-0000000000c${n}`,
  tableId: REC,
  recordId: REC,
  authorId: null,
  body: 'Hi',
  mentions: [],
  reactions: [],
  createdAt: at(minute),
  editedAt: null,
});

const field = (id: string, name: string, type = 'singleLineText') =>
  ({ id, name, type }) as FieldMeta;

describe('activity model (#94)', () => {
  it('merges revisions (newest first) and comments, oldest first', () => {
    const items = activityItems([revision(2, 30), revision(1, 10)], [comment(1, 20)], true);
    expect(items.map((i) => `${i.type}@${i.at.slice(14, 16)}`)).toEqual([
      'revision@10',
      'comment@20',
      'revision@30',
    ]);
  });

  it('holds back comments older than the loaded history while more is to load', () => {
    const items = activityItems([revision(2, 30)], [comment(1, 5), comment(2, 40)], false);
    expect(items.map((i) => i.type)).toEqual(['revision', 'comment']);
    expect(activityItems([], [comment(1, 5)], false)).toHaveLength(1);
  });

  it('says what a revision did', () => {
    const byId = new Map([F1, F2, F3].map((id, i) => [id, field(id, `F${i + 1}`)]));
    expect(revisionVerb(revision(1, 1, { kind: 'created', changes: [] }), byId)).toBe(
      'created this record'
    );
    expect(revisionVerb(revision(1, 1, { kind: 'deleted', changes: [] }), byId)).toBe(
      'deleted this record'
    );
    expect(revisionVerb(revision(1, 1), byId)).toBe('changed F1');
    const three = [F1, F2, F3].map((fieldId) => ({ fieldId, type: 't', before: 1, after: 2 }));
    expect(revisionVerb(revision(1, 1, { changes: three.slice(0, 2) }), byId)).toBe(
      'changed F1 and F2'
    );
    expect(revisionVerb(revision(1, 1, { changes: three }), byId)).toBe(
      'changed F1, F2 and 1 more'
    );
    expect(revisionVerb(revision(1, 1, { restoredFrom: REC }), byId)).toBe('restored F1');
  });

  it('renders values of a field whose type changed as plain text', () => {
    const change = { fieldId: F1, type: 'number', before: 1, after: 2 };
    expect(sameType(change, field(F1, 'F1', 'number'))).toBe(true);
    expect(sameType(change, field(F1, 'F1'))).toBe(false);
    expect(sameType(change, undefined)).toBe(false);
    expect(
      plainValue([
        { id: 'x', name: 'Alpha' },
        { id: 'y', filename: 'a.png' },
      ])
    ).toBe('Alpha, a.png');
    expect(plainValue(3)).toBe('3');
    expect(plainValue(null)).toBe('');
    expect(isEmptyValue([])).toBe(true);
    expect(isEmptyValue(false)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import type { OutboxRow } from '../data/outbox.js';
import { type FieldVisibility, projectEvent } from './projection.js';

const BASE = '0190a000-0000-7000-8000-000000000001';
const TABLE = '0190a000-0000-7000-8000-000000000002';
const ME = '0190a000-0000-7000-8000-000000000003';
const SOMEONE = '0190a000-0000-7000-8000-000000000004';
const SECRET = 'f-secret';
const viewer = { userId: ME, role: 'editor' as const };

function row(kind: string, payload: Record<string, unknown>): OutboxRow {
  return {
    id: 42,
    workspaceId: '0190a000-0000-7000-8000-000000000005',
    baseId: BASE,
    tableId: TABLE,
    kind,
    payload,
    actorId: SOMEONE,
    clientOpId: 'op-1',
    txid: '1000',
    automationId: null,
    automationDepth: null,
    createdAt: new Date('2026-10-26T10:00:00Z'),
  };
}

const hideSecret: FieldVisibility = { hiddenFields: () => new Set([SECRET]) };

describe('projectEvent', () => {
  it('maps an outbox row to the wire event', () => {
    expect(projectEvent(row('record.updated', { recordId: 'r', fieldIds: ['a'] }), viewer)).toEqual(
      {
        seq: 42,
        baseId: BASE,
        tableId: TABLE,
        kind: 'record.updated',
        payload: { recordId: 'r', fieldIds: ['a'] },
        actorId: SOMEONE,
        clientOpId: 'op-1',
        at: '2026-10-26T10:00:00.000Z',
      }
    );
  });

  it('strips the cells before an update or a deletion (for webhooks, #107)', () => {
    const update = row('record.updated', {
      recordId: 'r',
      fieldIds: ['a'],
      cells: { a: 2 },
      before: { a: 1 },
    });
    expect(projectEvent(update, viewer)?.payload).toEqual({
      recordId: 'r',
      fieldIds: ['a'],
      cells: { a: 2 },
    });
    const deleted = row('record.deleted', { recordId: 'r', version: 3, before: { a: 1 } });
    expect(projectEvent(deleted, viewer)?.payload).toEqual({ recordId: 'r', version: 3 });
  });

  it("drops another user's personal view events and strips the audience marker", () => {
    const mine = row('view.updated', { view: { id: 'v' }, personalTo: ME });
    const theirs = row('view.deleted', { viewId: 'v', personalTo: SOMEONE });
    const shared = row('view.created', { view: { id: 'v' }, personalTo: null });
    expect(projectEvent(mine, viewer)?.payload).toEqual({ view: { id: 'v' } });
    expect(projectEvent(theirs, viewer)).toBeNull();
    expect(projectEvent(shared, viewer)?.payload).toEqual({ view: { id: 'v' } });
  });

  it('removes hidden fields from record events and drops what is left empty', () => {
    const update = row('record.updated', {
      recordId: 'r',
      fieldIds: ['a', SECRET],
      cells: { a: 1, [SECRET]: 'x' },
    });
    expect(projectEvent(update, viewer, hideSecret)?.payload).toEqual({
      recordId: 'r',
      fieldIds: ['a'],
      cells: { a: 1 },
    });
    const onlySecret = row('record.updated', { fieldIds: [SECRET], cells: { [SECRET]: 'x' } });
    expect(projectEvent(onlySecret, viewer, hideSecret)).toBeNull();
    const created = row('record.created', { record: { id: 'r', fields: { a: 1, [SECRET]: 2 } } });
    expect(projectEvent(created, viewer, hideSecret)?.payload).toEqual({
      record: { id: 'r', fields: { a: 1 } },
    });
  });

  it('drops events about hidden fields', () => {
    expect(
      projectEvent(row('field.updated', { field: { id: SECRET } }), viewer, hideSecret)
    ).toBeNull();
    expect(projectEvent(row('field.deleted', { fieldId: SECRET }), viewer, hideSecret)).toBeNull();
    expect(
      projectEvent(row('field.updated', { field: { id: 'a' } }), viewer, hideSecret)
    ).not.toBeNull();
  });

  it('never projects a workspace-level event (no base)', () => {
    expect(projectEvent({ ...row('member.removed', {}), baseId: null }, viewer)).toBeNull();
  });
});

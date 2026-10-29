import { describe, expect, it } from 'vitest';
import { webhookEventType } from './payload.js';

const T1 = '01900000-0000-7000-8000-000000000001';
const T2 = '01900000-0000-7000-8000-000000000002';
const F1 = '01900000-0000-7000-8000-0000000000f1';
const F2 = '01900000-0000-7000-8000-0000000000f2';

const hook = (
  over: Partial<{ events: string[]; tableIds: string[]; fieldIds: string[] }> = {}
) => ({
  events: over.events ?? ['record.created', 'record.updated', 'record.deleted', 'table.created'],
  tableIds: over.tableIds ?? null,
  fieldIds: over.fieldIds ?? null,
});

describe('webhookEventType (#107)', () => {
  it('maps outbox kinds to the subscribed event types', () => {
    expect(webhookEventType(hook(), { kind: 'record.created', tableId: T1, payload: {} })).toBe(
      'record.created'
    );
    expect(webhookEventType(hook(), { kind: 'table.created', tableId: T1, payload: {} })).toBe(
      'table.created'
    );
    expect(webhookEventType(hook(), { kind: 'field.created', tableId: T1, payload: {} })).toBe(
      null
    );
    expect(webhookEventType(hook(), { kind: 'comment.created', tableId: T1, payload: {} })).toBe(
      null
    );
    expect(webhookEventType(hook(), { kind: 'record.restored', tableId: T1, payload: {} })).toBe(
      null
    );
  });

  it('delivers restores and comments when subscribed (#126)', () => {
    const all = hook({
      events: ['record.restored', 'field.restored', 'table.restored', 'comment.created'],
    });
    for (const kind of ['record.restored', 'field.restored', 'table.restored', 'comment.created']) {
      expect(webhookEventType(all, { kind, tableId: T1, payload: {} })).toBe(kind);
    }
    expect(webhookEventType(all, { kind: 'comment.updated', tableId: T1, payload: {} })).toBe(null);
    // Mentions are for notifications, never delivered.
    expect(
      webhookEventType(hook({ events: ['comment.created'] }), {
        kind: 'comment.mentioned',
        tableId: T1,
        payload: {},
      })
    ).toBe(null);
    expect(
      webhookEventType(hook({ events: ['comment.deleted'], tableIds: [T2] }), {
        kind: 'comment.deleted',
        tableId: T1,
        payload: {},
      })
    ).toBe(null);
  });

  it('delivers a form submission as form.submitted when subscribed, else as record.created', () => {
    const event = { kind: 'record.created', tableId: T1, payload: { via: 'form' } };
    expect(webhookEventType(hook({ events: ['form.submitted'] }), event)).toBe('form.submitted');
    expect(webhookEventType(hook({ events: ['record.created'] }), event)).toBe('record.created');
    expect(webhookEventType(hook({ events: ['form.submitted'] }), { ...event, payload: {} })).toBe(
      null
    );
  });

  it('applies the table and field filters, and skips computed-only updates', () => {
    const update = { kind: 'record.updated', tableId: T1, payload: { fieldIds: [F1] } };
    expect(webhookEventType(hook({ tableIds: [T2] }), update)).toBe(null);
    expect(webhookEventType(hook({ tableIds: [T1] }), update)).toBe('record.updated');
    expect(webhookEventType(hook({ fieldIds: [F2] }), update)).toBe(null);
    expect(webhookEventType(hook({ fieldIds: [F2, F1] }), update)).toBe('record.updated');
    expect(
      webhookEventType(hook(), { ...update, payload: { fieldIds: [F1], computed: true } })
    ).toBe(null);
  });
});

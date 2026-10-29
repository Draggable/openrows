import { describe, expect, it } from 'vitest';
import {
  lookup,
  parsePath,
  renderTemplate,
  renderValue,
  TemplateError,
  templatePaths,
  valuePaths,
} from './template.js';

const context = {
  trigger: {
    record: {
      id: 'rec-1',
      fields: {
        Name: 'Launch',
        'Due date': '2026-11-02',
        Points: 8,
        Done: false,
        Tags: [
          { id: 'c1', name: 'Urgent' },
          { id: 'c2', name: 'Q4' },
        ],
        Owner: { id: 'u1', name: 'Ada' },
        Empty: null,
      },
    },
  },
  steps: {
    1: { records: [{ id: 'rec-9', fields: { Name: 'Found' } }], count: 1 },
  },
};

describe('parsePath', () => {
  it('reads dots, indexes and quoted keys', () => {
    expect(parsePath('trigger.record.fields.Name')).toEqual([
      'trigger',
      'record',
      'fields',
      'Name',
    ]);
    expect(parsePath(' steps.1.records[0].id ')).toEqual(['steps', 1, 'records', 0, 'id']);
    expect(parsePath('trigger.record.fields["Due date"]')).toEqual([
      'trigger',
      'record',
      'fields',
      'Due date',
    ]);
    expect(parsePath("trigger.record.fields['a.b']")).toEqual([
      'trigger',
      'record',
      'fields',
      'a.b',
    ]);
    expect(parsePath('trigger.record.fields.Due date')).toEqual([
      'trigger',
      'record',
      'fields',
      'Due date',
    ]);
  });

  it('refuses other roots and malformed paths', () => {
    for (const bad of [
      'process.env',
      'globalThis',
      '',
      'trigger..x',
      'trigger[',
      'trigger[x]',
      '1+1',
      'trigger()',
    ]) {
      expect(() => parsePath(bad), bad).toThrow(TemplateError);
    }
    expect(() => parsePath(`trigger${'.a'.repeat(20)}`)).toThrow(/too deep/);
  });
});

describe('rendering', () => {
  it('keeps the value of a whole-string token', () => {
    expect(renderTemplate('{{trigger.record.fields.Points}}', context)).toBe(8);
    expect(renderTemplate('{{ trigger.record.fields.Tags }}', context)).toEqual(
      context.trigger.record.fields.Tags
    );
    expect(renderTemplate('{{steps.1.records[0].id}}', context)).toBe('rec-9');
    expect(renderTemplate('{{trigger.record.fields.Missing}}', context)).toBeNull();
  });

  it('writes text into a string', () => {
    expect(
      renderTemplate(
        '{{trigger.record.fields.Name}} ({{trigger.record.fields.Points}} pts, {{trigger.record.fields.Done}}) due {{trigger.record.fields.Due date}}',
        context
      )
    ).toBe('Launch (8 pts, false) due 2026-11-02');
    expect(
      renderTemplate(
        'Tags: {{trigger.record.fields.Tags}}; by {{trigger.record.fields.Owner}}',
        context
      )
    ).toBe('Tags: Urgent, Q4; by Ada');
    expect(
      renderTemplate('[{{trigger.record.fields.Empty}}][{{trigger.nope.deeper}}]', context)
    ).toBe('[][]');
    expect(renderTemplate('no tokens {here}', context)).toBe('no tokens {here}');
  });

  it('never reaches past own data', () => {
    expect(lookup(context, ['trigger', '__proto__'])).toBeUndefined();
    expect(lookup(context, ['trigger', 'constructor'])).toBeUndefined();
    expect(lookup(context, ['trigger', 'record', 'id', 'length'])).toBeUndefined();
    expect(lookup(context, ['trigger', 'record', 'fields', 'Tags', 'length'])).toBeUndefined();
    expect(lookup(context, ['trigger', 'toString'])).toBeUndefined();
    expect(renderTemplate('{{trigger.constructor.constructor}}', context)).toBeNull();
  });

  it('walks arrays and objects', () => {
    expect(
      renderValue(
        { a: '{{trigger.record.id}}', b: ['x {{trigger.record.fields.Name}}', 3], c: null },
        context
      )
    ).toEqual({ a: 'rec-1', b: ['x Launch', 3], c: null });
    expect(valuePaths({ a: ['{{steps.1.count}}', '{{trigger.record.id}}'] })).toEqual([
      ['steps', 1, 'count'],
      ['trigger', 'record', 'id'],
    ]);
  });

  it('caps the tokens per value', () => {
    expect(() => templatePaths('{{trigger.a}}'.repeat(51))).toThrow(/at most 50/);
  });
});

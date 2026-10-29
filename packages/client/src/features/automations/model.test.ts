import {
  type AutomationRun,
  createAutomationSchema,
  type FieldMeta,
  parseTemplatePath as parsePath,
} from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import {
  ACTION_TYPES,
  bodyTokens,
  canRetry,
  cardErrors,
  defaultAction,
  defaultTrigger,
  generalErrors,
  insertToken,
  moveItem,
  pathKey,
  problemErrors,
  runSubject,
  scriptOutputNames,
  TRIGGER_TYPES,
  tokensFor,
  tomorrowAtNine,
} from './model';

const T1 = '0190a000-0000-7000-8000-000000000001';
const T2 = '0190a000-0000-7000-8000-000000000002';

const field = (name: string, id = crypto.randomUUID()): FieldMeta => ({
  id,
  tableId: T1,
  name,
  description: null,
  type: 'singleLineText',
  options: {},
  isPrimary: false,
  position: 1,
  createdAt: '2026-10-25T10:00:00.000Z',
  updatedAt: '2026-10-25T10:00:00.000Z',
  deletedAt: null,
});

const run = (over: Partial<AutomationRun>): AutomationRun => ({
  id: crypto.randomUUID(),
  automationId: T1,
  status: 'failed',
  mode: 'live',
  skipReason: null,
  retryOf: null,
  trigger: { type: 'recordCreated', record: { id: T2, fields: { Name: 'Ship it' } } },
  steps: [],
  error: 'Step 1 failed',
  depth: 1,
  triggeredBy: null,
  durationMs: 3,
  createdAt: '2026-10-25T10:00:00.000Z',
  ...over,
});

describe('automation builder model (#111)', () => {
  it('makes a valid automation of every trigger and action type the schema accepts', () => {
    for (const type of TRIGGER_TYPES) {
      const trigger = defaultTrigger(type, T1, new Date(2026, 9, 27, 15));
      const actions = ACTION_TYPES.map((a) => defaultAction(a, trigger, T2));
      const parsed = createAutomationSchema.safeParse({ name: 'A', trigger, actions });
      // A new form or button trigger still needs its view or field picked, and new email,
      // Slack and HTTP steps their recipients, text and URL: the rest parses as is.
      const issues = parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.'));
      const expected = [
        ...(type === 'formSubmitted' ? ['trigger.viewId'] : []),
        ...(type === 'buttonClicked' ? ['trigger.fieldId'] : []),
        ...(type === 'scheduled' || type === 'webhookReceived' ? ['actions.1.recordId'] : []),
        'actions.3.to',
        'actions.3.subject',
        'actions.4.text',
        'actions.5.url',
      ];
      expect(issues.sort()).toEqual(expected.sort());
    }
  });

  it('starts record steps on the trigger table and updates point at the trigger record', () => {
    const trigger = defaultTrigger('recordUpdated', T1);
    expect(defaultAction('updateRecord', trigger, T2)).toMatchObject({
      tableId: T1,
      recordId: '{{trigger.record.id}}',
    });
    expect(defaultAction('createRecord', defaultTrigger('scheduled', ''), T2)).toMatchObject({
      tableId: T2,
    });
    expect(tomorrowAtNine(new Date(2026, 11, 31, 22))).toBe('2027-01-01T09:00');
  });

  it('moves steps up and down, ignoring moves off the ends', () => {
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], 1, 2)).toEqual(['a', 'b']);
  });

  it('writes token keys the token grammar reads back to the same name', () => {
    for (const name of ['Name', 'Due date', 'a.b', 'x[0]', '42', ' pad ', 'say "hi"', "it's"]) {
      const key = pathKey(name, 'fallback-id');
      const path = parsePath(`trigger.record.fields${key}`);
      expect(path.at(-1)).toBe(name);
    }
    expect(pathKey('{curly}', 'id-1')).toBe('.id-1');
    expect(pathKey(`a."b" 'c'`, 'id-2')).toBe('.id-2');
    expect(pathKey(`both " and '`, 'id-3')).toBe(`.both " and '`);
  });

  it('offers the trigger and only earlier steps as tokens, with friendly labels', () => {
    const name = field('Name');
    const due = field('Due date');
    const trigger = defaultTrigger('buttonClicked', T1);
    const actions = [
      defaultAction('findRecords', trigger, T1),
      defaultAction('httpRequest', trigger, T1),
      defaultAction('sendEmail', trigger, T1),
    ];
    const ctx = { trigger, actions, fieldsOf: () => [name, due] };
    const first = tokensFor(ctx, 1);
    expect(first.map((t) => t.group)).not.toContain('Step 1: Find records');
    expect(first).toContainEqual({
      group: 'Trigger',
      label: 'Record › Due date',
      token: '{{trigger.record.fields.Due date}}',
    });
    expect(first.map((t) => t.token)).toContain('{{trigger.user.email}}');
    const third = tokensFor(ctx, 3);
    expect(third).toContainEqual({
      group: 'Step 1: Find records',
      label: 'First record › Name',
      token: '{{steps.1.records[0].fields.Name}}',
    });
    expect(third.map((t) => t.token)).toContain('{{steps.2.body}}');
    expect(third.map((t) => t.group)).not.toContain('Step 3: Send email');
    // Every token parses.
    for (const t of third) expect(() => parsePath(t.token.slice(2, -2))).not.toThrow();
  });

  it("lists a webhook sample's leaves as tokens", () => {
    const tokens = bodyTokens({ order: { id: 7, items: [{ sku: 'A-1' }] }, 'odd.key': true });
    expect(tokens.map((t) => [t.label, t.token])).toEqual([
      ['order › id', '{{trigger.body.order.id}}'],
      ['order › items › 1st › sku', '{{trigger.body.order.items[0].sku}}'],
      ['odd.key', '{{trigger.body["odd.key"]}}'],
    ]);
    const trigger = defaultTrigger('webhookReceived', '');
    expect(
      tokensFor({ trigger, actions: [], fieldsOf: () => undefined, webhookSample: null }, 1).map(
        (t) => t.token
      )
    ).toEqual(['{{trigger.body}}']);
  });

  it('inserts a token at the caret or over the selection', () => {
    expect(insertToken('Hello !', 6, 6, '{{x}}')).toEqual({ value: 'Hello {{x}}!', caret: 11 });
    expect(insertToken('Hello world', 6, 11, '{{x}}')).toEqual({
      value: 'Hello {{x}}',
      caret: 11,
    });
    expect(insertToken('ab', null, null, '{{x}}')).toEqual({ value: 'ab{{x}}', caret: 7 });
  });

  it("sorts the server's 422 into the cards, inline paths staying inline", () => {
    const err = new ApiError(422, 'The automation is invalid.', {
      errors: [
        { path: 'trigger.tableId', message: 'No such table in this base.' },
        { path: 'trigger.filter.conditions.0', message: 'Unknown operator.' },
        { path: 'actions.1.fields.0190a000-0000-7000-8000-000000000009', message: 'Computed.' },
        {
          path: 'actions.1.headers.0.value',
          message: "A secret header's value can't hold tokens.",
        },
        { path: 'actions.1', message: 'Step 2 can only use the steps before it.' },
        { path: 'enabled', message: 'Add an action before turning the automation on.' },
      ],
    });
    const { byPath, message } = problemErrors(err, 'fallback');
    expect(message).toBe('The automation is invalid.');
    expect(cardErrors(byPath, 'trigger')).toEqual(['Unknown operator.']);
    expect(cardErrors(byPath, 'actions.1')).toEqual([
      "A secret header's value can't hold tokens.",
      'Step 2 can only use the steps before it.',
    ]);
    expect(cardErrors(byPath, 'actions.10')).toEqual([]);
    expect(generalErrors(byPath)).toEqual(['Add an action before turning the automation on.']);
    expect(problemErrors(new Error('x'), 'fallback')).toEqual({ message: 'fallback', byPath: {} });
  });

  it('names runs and allows one retry of a failed run with trigger data', () => {
    const failed = run({});
    expect(runSubject(failed)).toBe('Ship it');
    expect(runSubject(run({ trigger: { type: 'scheduled' } }))).toBe('Scheduled run');
    expect(canRetry(failed, [failed])).toBe(true);
    expect(canRetry(failed, [failed, run({ retryOf: failed.id, mode: 'retry' })])).toBe(false);
    expect(canRetry(run({ status: 'skipped' }), [])).toBe(false);
    expect(canRetry(run({ mode: 'test' }), [])).toBe(false);
    expect(canRetry(run({ trigger: {} }), [])).toBe(false);
  });

  it('starts a script step with an example and offers its literal outputs as tokens (#112)', () => {
    const trigger = { type: 'recordCreated' as const, tableId: 't1' };
    const action = defaultAction('runScript', trigger, 't1', "Bob's 'tasks'");
    expect(action).toMatchObject({
      type: 'runScript',
      inputs: { recordId: '{{trigger.record.id}}' },
    });
    expect(action.type === 'runScript' && action.script).toContain(
      "base.getTable('Bob\\'s \\'tasks\\'')"
    );
    expect(defaultAction('runScript', { type: 'webhookReceived' }, 't1')).toMatchObject({
      inputs: {},
    });
    expect(
      scriptOutputNames(
        `output.set('a', 1); output.set("b", 2); output.set(name, 3); output.set('a', 4)`
      )
    ).toEqual(['a', 'b']);
  });
});

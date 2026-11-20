import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_ACTION_TYPES,
  createAutomationSchema,
  EXTERNAL_ACTION_TYPES,
  isExternalActionType,
  MAX_AUTOMATION_ACTIONS,
  MAX_RUN_EXTERNAL_ACTIONS,
  MAX_SCRIPT_INPUTS,
  MAX_SCRIPT_LENGTH,
  MAX_STEP_DEPTH,
} from './automation.js';

const trigger = { type: 'recordCreated', tableId: '01a17db5-dd06-713a-bc40-74cc8eb80a47' };
const parse = (action: Record<string, unknown>) =>
  createAutomationSchema.safeParse({ name: 'A', trigger, actions: [action] });
const paths = (r: ReturnType<typeof parse>) =>
  r.success ? [] : r.error.issues.map((i) => i.path.join('.'));

describe('run-script actions (#112)', () => {
  it('takes a script and input variables, defaulting to none', () => {
    const r = parse({ type: 'runScript', script: 'output.set("a", 1)' });
    expect(r.success && r.data.actions[0]).toEqual({
      type: 'runScript',
      script: 'output.set("a", 1)',
      inputs: {},
    });
  });

  it('checks tokens in the inputs only: the script is code, never filled in', () => {
    const code = "// {{steps.9.output}} and {{nonsense in a comment\nconst s = '{{x}}';";
    expect(paths(parse({ type: 'runScript', script: code }))).toEqual([]);
    expect(
      paths(parse({ type: 'runScript', script: 'x', inputs: { id: '{{steps.1.records}}' } }))
    ).toEqual(['actions.0']);
    expect(
      paths(parse({ type: 'runScript', script: 'x', inputs: { id: '{{trigger.record.id}}' } }))
    ).toEqual([]);
  });

  it('caps the script, the inputs and their names', () => {
    expect(paths(parse({ type: 'runScript', script: '' }))).toEqual(['actions.0.script']);
    expect(
      paths(parse({ type: 'runScript', script: 'x'.repeat(MAX_SCRIPT_LENGTH + 1) }))
    ).toContain('actions.0.script');
    expect(paths(parse({ type: 'runScript', script: 'x', inputs: { 'not ok': 'v' } }))).toEqual([
      'actions.0.inputs.not ok',
    ]);
    // Zod leaves a `__proto__` key out; `constructor` and `prototype` are refused.
    const proto = parse({
      type: 'runScript',
      script: 'x',
      inputs: JSON.parse('{"__proto__": "v"}'),
    });
    expect(
      proto.success &&
        Object.keys(proto.data.actions[0]?.type === 'runScript' ? proto.data.actions[0].inputs : {})
    ).toEqual([]);
    expect(paths(parse({ type: 'runScript', script: 'x', inputs: { constructor: 'v' } }))).toEqual([
      'actions.0.inputs.constructor',
    ]);
    const many = Object.fromEntries(
      Array.from({ length: MAX_SCRIPT_INPUTS + 1 }, (_, i) => [`v${i}`, 'x'])
    );
    expect(paths(parse({ type: 'runScript', script: 'x', inputs: many }))).toEqual([
      'actions.0.inputs',
    ]);
  });
});

describe('If / Otherwise and Repeat for each steps (#21)', () => {
  const T = trigger.tableId;
  const F = '01a17db5-dd06-713a-bc40-74cc8eb80a48';
  const noFilter = { conjunction: 'and', conditions: [] };
  const setting = (value: string) => ({ ...create, fields: { [F]: value } });
  const create = { type: 'createRecord', tableId: T, fields: {} };
  const branch = (
    then: unknown[] = [],
    otherwise: unknown[] = [],
    recordId = '{{trigger.record.id}}'
  ) => ({
    type: 'branch',
    tableId: T,
    recordId,
    filter: noFilter,
    then,
    otherwise,
  });
  const repeat = (actions: unknown[] = [], items = '{{trigger.record.fields.Tasks}}') => ({
    type: 'repeat',
    items,
    actions,
  });
  const parseAll = (actions: unknown[]) =>
    createAutomationSchema.safeParse({ name: 'A', trigger, actions });
  const issues = (r: ReturnType<typeof parseAll>) =>
    r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);

  it('still takes flat configs as before, unchanged', () => {
    const flat = [
      { type: 'findRecords', tableId: T, limit: 5 },
      { type: 'updateRecord', tableId: T, recordId: '{{steps.1.records}}', fields: { [F]: 1 } },
      { type: 'sendEmail', to: ['a@example.com'], subject: '{{steps.2.count}} updated' },
    ];
    const r = parseAll(flat);
    expect(issues(r)).toEqual([]);
    expect(r.success && r.data.actions).toEqual([flat[0], flat[1], { ...flat[2], body: '' }]);
  });

  it('takes branches and repeats, nested lists defaulting to none', () => {
    const r = parseAll([
      { type: 'branch', tableId: T, recordId: '{{trigger.record.id}}', filter: noFilter },
      { type: 'repeat', items: '{{trigger.record.fields.Tasks}}' },
    ]);
    expect(issues(r)).toEqual([]);
    expect(r.success && r.data.actions).toEqual([branch(), repeat()]);
  });

  it('checks the nested steps like top-level ones, with their paths', () => {
    const r = parseAll([branch([create, { type: 'sendEmail', to: [], subject: 'x' }])]);
    expect(issues(r).map((i) => i.split(':')[0])).toEqual(['actions.0.then.1.to']);
    expect(issues(parseAll([repeat([{ type: 'nope' }])]))[0]).toMatch(/^actions\.0\.actions\.0/);
  });

  it('counts every step, nested ones and the groups, toward the limit', () => {
    const many = Array.from({ length: MAX_AUTOMATION_ACTIONS - 1 }, () => create);
    expect(issues(parseAll([repeat(many)]))).toEqual([]);
    expect(issues(parseAll([repeat(many), create]))).toEqual([
      'actions: An automation has at most 25 steps, counting the steps inside If / Otherwise and Repeat for each.',
    ]);
    expect(issues(parseAll([branch(many.slice(0, 12), many.slice(0, 12)), create])).length).toBe(1);
  });

  it('caps external steps per run at the flat-list maximum, so a flat automation never reaches it', () => {
    expect(MAX_RUN_EXTERNAL_ACTIONS).toBe(25);
    expect(MAX_RUN_EXTERNAL_ACTIONS).toBe(MAX_AUTOMATION_ACTIONS);
    expect([...EXTERNAL_ACTION_TYPES].sort()).toEqual([
      'discordMessage',
      'httpRequest',
      'runScript',
      'sendEmail',
      'slackMessage',
    ]);
    expect(AUTOMATION_ACTION_TYPES.filter(isExternalActionType)).toEqual([
      ...EXTERNAL_ACTION_TYPES,
    ]);
    for (const type of [
      'createRecord',
      'updateRecord',
      'findRecords',
      'branch',
      'repeat',
    ] as const) {
      expect(isExternalActionType(type)).toBe(false);
    }
  });

  it('nests at most three levels: a group may hold the other kind of group', () => {
    expect(issues(parseAll([branch([repeat([create])])]))).toEqual([]);
    expect(issues(parseAll([repeat([branch([create], [create])])]))).toEqual([]);
    expect(issues(parseAll([repeat([branch([repeat([create])])])]))).toEqual([
      `actions.0.actions.0.then.0.actions.0: Step 1.actions.1.then.1.actions.1 is nested too deep: groups hold steps at most ${MAX_STEP_DEPTH} levels deep.`,
    ]);
  });

  it('lets nested steps use the groups around them and the steps before them', () => {
    const ok = parseAll([
      { type: 'findRecords', tableId: T },
      repeat(
        [
          setting('{{steps.2.item.id}} {{steps.2.index}} {{steps.1.count}}'),
          branch(
            [setting('{{steps.2.actions.1.record.id}} {{steps.2.actions.2.path}}')],
            [setting('{{steps.2.item.fields.Name}}')],
            '{{steps.2.actions.1.id}}'
          ),
        ],
        '{{steps.1.records}}'
      ),
      setting('{{steps.2.count}} {{steps.2.items}}'),
      branch([create, setting('{{steps.4.then.1.id}}')], [create]),
      setting('{{steps.4.path}} {{steps.4.then.2.id}} {{steps.4.otherwise.1.id}}'),
    ]);
    expect(issues(ok)).toEqual([]);
  });

  it('refuses tokens to later steps, the other path, itself or inside a finished repeat', () => {
    const cases: [unknown[], string][] = [
      // A group's own settings can't use its own output.
      [[repeat([], '{{steps.1.items}}')], 'actions.0: Step 1 can only use the steps before it.'],
      [
        [branch([], [], '{{steps.1.then.1.id}}')],
        'actions.0: Step 1 can only use the steps before it.',
      ],
      // The other path of the same branch.
      [
        [branch([create], [setting('{{steps.1.then.1.id}}')])],
        'actions.0.otherwise.0: Step 1.otherwise.1 can only use the steps before it.',
      ],
      // A later step of the same list.
      [
        [repeat([setting('{{steps.1.actions.2.id}}'), create])],
        'actions.0.actions.0: Step 1.actions.1 can only use the steps before it.',
      ],
      // Inside a repeat that already finished.
      [
        [repeat([create]), setting('{{steps.1.actions.1.id}}')],
        'actions.1: Step 2 uses a step inside a Repeat for each; only the steps after it in the same group can.',
      ],
      // A step that doesn't exist.
      [
        [branch([create]), setting('{{steps.1.then.4.id}}')],
        "actions.1: Step 2 uses step 1.then.4, which doesn't exist.",
      ],
    ];
    for (const [actions, issue] of cases) expect(issues(parseAll(actions))).toEqual([issue]);
  });
});

describe('Send Discord message actions', () => {
  const HOOK = 'https://discord.com/api/webhooks/123456789012345678/AbC-d_eF0123';
  const discord = (over: Record<string, unknown> = {}) => ({
    type: 'discordMessage',
    webhookUrl: HOOK,
    text: 'Hello',
    ...over,
  });
  const messages = (r: ReturnType<typeof parse>) =>
    r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);

  it('takes a webhook URL and a message, mentioning no one by default', () => {
    const r = parse(discord());
    expect(r.success && r.data.actions[0]).toEqual({
      type: 'discordMessage',
      webhookUrl: HOOK,
      text: 'Hello',
      mentions: [],
    });
  });

  it.each([
    HOOK,
    'https://discordapp.com/api/webhooks/1/token',
    'https://ptb.discord.com/api/webhooks/1/token',
    'https://canary.discord.com/api/webhooks/1/token',
    'https://discord.com/api/v10/webhooks/1/token',
    'https://discord.com/api/v9/webhooks/1/token',
  ])('accepts %s', (url) => {
    expect(paths(parse(discord({ webhookUrl: url })))).toEqual([]);
  });

  it.each([
    // Not https.
    'http://discord.com/api/webhooks/1/token',
    'ftp://discord.com/api/webhooks/1/token',
    // Other hosts, lookalikes and spellings that could reach one.
    'https://example.com/api/webhooks/1/token',
    'https://hooks.slack.com/services/T0/B0/x',
    'https://discord.com.evil.example/api/webhooks/1/token',
    'https://evil.example/discord.com/api/webhooks/1/token',
    'https://discord.com@evil.example/api/webhooks/1/token',
    'https://evil.example#@discord.com/api/webhooks/1/token',
    'https://evildiscord.com/api/webhooks/1/token',
    'https://discord.co/api/webhooks/1/token',
    'https://discord.com./api/webhooks/1/token',
    'https://www.discord.com/api/webhooks/1/token',
    'https://cdn.discordapp.com/api/webhooks/1/token',
    'https://DISCORD.COM/api/webhooks/1/token',
    'https://xn--discrd-6ya.com/api/webhooks/1/token',
    // IP literals, ports, credentials.
    'https://162.159.135.232/api/webhooks/1/token',
    'https://[::1]/api/webhooks/1/token',
    'https://127.0.0.1/api/webhooks/1/token',
    'https://169.254.169.254/api/webhooks/1/token',
    'https://discord.com:8443/api/webhooks/1/token',
    'https://user:pass@discord.com/api/webhooks/1/token',
    // Other paths, or more after the token.
    'https://discord.com/api/webhooks/1',
    'https://discord.com/api/webhooks/abc/token',
    'https://discord.com/webhooks/1/token',
    'https://discord.com/api/v10/channels/1/messages',
    'https://discord.com/api/webhooks/1/token/slack',
    'https://discord.com/api/webhooks/1/token/../../../users/@me',
    'https://discord.com/api/webhooks/1/token?thread_id=2',
    'https://discord.com/api/webhooks/1/token#x',
    'https://discord.com/api/webhooks/1/tok en',
    'https://discord.com\\api\\webhooks\\1\\token',
    // Tokens: the URL is a fixed secret.
    'https://discord.com/api/webhooks/{{trigger.body.id}}/token',
    '{{trigger.body.url}}',
    'not a url',
  ])('refuses %s with a message on its webhookUrl', (url) => {
    const r = parse(discord({ webhookUrl: url }));
    expect(paths(r)).toContain('actions.0.webhookUrl');
    expect(messages(r).join('\n')).toMatch(/actions\.0\.webhookUrl: .*Discord webhook URL/);
  });

  it('says why a URL is refused', () => {
    const why = (url: string) => messages(parse(discord({ webhookUrl: url })))[0];
    expect(why('http://discord.com/api/webhooks/1/t')).toContain('starts with https://');
    expect(why('https://discord.com.evil.example/api/webhooks/1/t')).toContain('is on discord.com');
    expect(why('https://discord.com/api/channels/1')).toContain('looks like');
  });

  it('may leave the URL out (the stored one is kept), and then still checks the rest', () => {
    expect(paths(parse({ type: 'discordMessage', text: 'Hi' }))).toEqual([]);
  });

  it('needs a message or an embed with a title or a description', () => {
    expect(messages(parse(discord({ text: '' })))).toEqual([
      'actions.0.text: Write a message or add an embed.',
    ]);
    expect(messages(parse(discord({ text: '   ' })))).toEqual([
      'actions.0.text: Write a message or add an embed.',
    ]);
    expect(paths(parse(discord({ text: '', embed: { title: 'T' } })))).toEqual([]);
    expect(paths(parse(discord({ text: '', embed: { description: 'D' } })))).toEqual([]);
    expect(paths(parse(discord({ text: '', embed: { color: '#5865F2' } })))).toEqual([
      'actions.0.embed.title',
    ]);
  });

  it("keeps to Discord's limits", () => {
    const over = (n: number) => 'x'.repeat(n + 1);
    expect(paths(parse(discord({ text: 'x'.repeat(2000) })))).toEqual([]);
    expect(paths(parse(discord({ text: over(2000) })))).toEqual(['actions.0.text']);
    expect(paths(parse(discord({ username: 'x'.repeat(80) })))).toEqual([]);
    expect(paths(parse(discord({ username: over(80) })))).toEqual(['actions.0.username']);
    expect(paths(parse(discord({ embed: { title: over(256) } })))).toEqual([
      'actions.0.embed.title',
    ]);
    expect(paths(parse(discord({ embed: { title: 'T', description: over(4096) } })))).toEqual([
      'actions.0.embed.description',
    ]);
    expect(paths(parse(discord({ embed: { title: 'x'.repeat(256), description: 'x' } })))).toEqual(
      []
    );
  });

  it('checks the embed link and colour', () => {
    const embed = (e: Record<string, unknown>) =>
      paths(parse(discord({ embed: { title: 'T', ...e } })));
    expect(embed({ url: 'https://example.com/a', color: '#5865f2' })).toEqual([]);
    expect(embed({ url: '{{trigger.body.link}}' })).toEqual([]);
    expect(embed({ url: 'javascript:alert(1)' })).toEqual(['actions.0.embed.url']);
    expect(embed({ url: 'not a url' })).toEqual(['actions.0.embed.url']);
    expect(embed({ color: 'red' })).toEqual(['actions.0.embed.color']);
    expect(embed({ color: '#12345' })).toEqual(['actions.0.embed.color']);
    expect(embed({ color: '{{trigger.body.colour}}' })).toEqual(['actions.0.embed.color']);
    expect(embed({ extra: 1 })).toEqual(['actions.0.embed']);
  });

  it('takes who may be notified from a fixed list', () => {
    const r = parse(discord({ mentions: ['users', 'everyone'] }));
    expect(r.success && r.data.actions[0]).toMatchObject({ mentions: ['users', 'everyone'] });
    expect(paths(parse(discord({ mentions: ['here'] })))).toEqual(['actions.0.mentions.0']);
  });

  it('checks tokens in the message, display name and embed like other steps', () => {
    expect(
      paths(
        parse(
          discord({
            text: 'New: {{trigger.record.fields.Name}}',
            username: '{{trigger.record.fields.Owner}}',
            embed: { title: '{{trigger.record.id}}', description: '{{steps.1.count}}' },
          })
        )
      )
    ).toEqual(['actions.0']);
    expect(
      paths(parse(discord({ text: '{{trigger.record.id}}', username: '{{trigger.record.id}}' })))
    ).toEqual([]);
  });

  it('refuses a bad URL at its path inside groups', () => {
    const r = createAutomationSchema.safeParse({
      name: 'A',
      trigger,
      actions: [
        {
          type: 'branch',
          tableId: trigger.tableId,
          recordId: '{{trigger.record.id}}',
          filter: { conjunction: 'and', conditions: [] },
          // biome-ignore lint/suspicious/noThenProperty: a list of steps (an array, never a function)
          then: [
            {
              type: 'repeat',
              items: '{{trigger.record.id}}',
              actions: [
                discord({ webhookUrl: 'https://discord.com.evil.example/api/webhooks/1/t' }),
              ],
            },
          ],
        },
      ],
    });
    expect(paths(r)).toEqual(['actions.0.then.0.actions.0.webhookUrl']);
  });
});

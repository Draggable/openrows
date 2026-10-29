import { createHmac } from 'node:crypto';
import type { IDataObject } from 'n8n-workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FakeApi, fakeApi, TOKEN } from '../../../test/fake-api';
import { hookContext, loadOptionsContext, rl, webhookContext } from '../../testing/harness';
import { OpenRowsTrigger } from './OpenRowsTrigger.node';
import { verifySignature } from './signature';

const SECRET = 'whsec_test-secret';
const now = () => Math.floor(Date.now() / 1000);
const sign = (body: string, t = now(), secret = SECRET) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

describe('verifySignature', () => {
  const body = '{"id":"e1","type":"ping"}';

  it('accepts a fresh signature over the raw body', () => {
    expect(verifySignature(SECRET, sign(body), body)).toBe(true);
    expect(verifySignature(SECRET, sign(body), Buffer.from(body))).toBe(true);
    // Any one of several v1 values may match.
    expect(verifySignature(SECRET, `${sign(body)},v1=${'0'.repeat(64)}`, body)).toBe(true);
  });

  it('refuses another secret, a changed body, or a malformed header', () => {
    expect(verifySignature('whsec_other', sign(body), body)).toBe(false);
    expect(verifySignature(SECRET, sign(body), `${body} `)).toBe(false);
    expect(verifySignature(SECRET, sign(body).replace(/v1=.*/, 'v1=zz'), body)).toBe(false);
    expect(verifySignature(SECRET, sign(body).replace(/v1=(.*)/, 'v1=$1aa'), body)).toBe(false);
    expect(verifySignature(SECRET, 'v1=abc', body)).toBe(false);
    expect(verifySignature(SECRET, undefined, body)).toBe(false);
    expect(verifySignature(SECRET, `${sign(body)},${'x'.repeat(1100)}`, body)).toBe(false);
    expect(verifySignature('', sign(body, now(), ''), body)).toBe(false);
  });

  it('refuses a timestamp more than 5 minutes away (replays)', () => {
    const t = now();
    expect(verifySignature(SECRET, sign(body, t - 301), body)).toBe(false);
    expect(verifySignature(SECRET, sign(body, t + 301), body)).toBe(false);
    expect(verifySignature(SECRET, sign(body, t - 299), body)).toBe(true);
    expect(verifySignature(SECRET, sign(body, t - 10), body, { now: t, toleranceSeconds: 5 })).toBe(
      false
    );
  });
});

describe('OpenRows Trigger', () => {
  let api: FakeApi;
  let credentials: { baseUrl: string; apiKey: string };
  const trigger = new OpenRowsTrigger();
  const hooks = trigger.webhookMethods.default;
  const webhookUrl = 'https://n8n.example.com/webhook/abc/webhook';

  beforeAll(async () => {
    api = fakeApi();
    credentials = { baseUrl: await api.start(), apiKey: TOKEN };
  });
  afterAll(() => api.stop());
  beforeEach(() => {
    api.webhooks.length = 0;
    api.requests.length = 0;
  });

  const hook = (staticData: IDataObject, params: Record<string, unknown> = {}) =>
    hookContext({
      params: {
        base: rl(api.baseId),
        events: ['record.created', 'record.updated'],
        tableIds: [],
        ...params,
      },
      credentials,
      staticData,
      webhookUrl,
    });

  it('registers a webhook on activation and deletes it on deactivation', async () => {
    const staticData: IDataObject = {};
    expect(await hooks.checkExists.call(hook(staticData))).toBe(false);
    expect(await hooks.create.call(hook(staticData, { tableIds: [api.tasks.id] }))).toBe(true);
    expect(api.webhooks).toHaveLength(1);
    expect(api.webhooks[0]).toMatchObject({
      url: webhookUrl,
      description: 'n8n: Sync tasks',
      events: ['record.created', 'record.updated'],
      tableIds: [api.tasks.id],
    });
    expect(staticData).toEqual({
      webhookId: api.webhooks[0]?.id,
      baseId: api.baseId,
      secret: api.webhooks[0]?.secret,
    });
    expect(api.requests.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(await hooks.checkExists.call(hook(staticData))).toBe(true);

    expect(await hooks.delete.call(hook(staticData))).toBe(true);
    expect(api.webhooks).toEqual([]);
    expect(staticData).toEqual({});
  });

  it('sends every table as null and leaves out unknown events', async () => {
    const staticData: IDataObject = {};
    await hooks.create.call(hook(staticData, { events: ['record.deleted', 'nope'] }));
    expect(api.requests.at(-1)?.body).toEqual({
      url: webhookUrl,
      description: 'n8n: Sync tasks',
      events: ['record.deleted'],
      tableIds: null,
    });
  });

  it('refuses no base, no events, or table ids that are not ids', async () => {
    await expect(hooks.create.call(hook({}, { base: rl('') }))).rejects.toThrow('Pick a base');
    await expect(hooks.create.call(hook({}, { events: [] }))).rejects.toThrow('at least one event');
    await expect(hooks.create.call(hook({}, { tableIds: ['Tasks'] }))).rejects.toThrow(
      'not a table ID'
    );
    expect(api.requests).toEqual([]);
  });

  it('registers afresh when its webhook is gone, moved or turned off', async () => {
    const staticData: IDataObject = {};
    await hooks.create.call(hook(staticData));
    api.webhooks.length = 0;
    expect(await hooks.checkExists.call(hook(staticData))).toBe(false);
    expect(staticData).toEqual({});

    await hooks.create.call(hook(staticData));
    const first = api.webhooks[0];
    if (first) first.enabled = false;
    expect(await hooks.checkExists.call(hook(staticData))).toBe(false);
    // The turned-off one is deleted rather than left behind.
    expect(api.webhooks).toEqual([]);
  });

  it("leaves another URL's webhook alone (the production one while testing)", async () => {
    const production: IDataObject = {};
    await hooks.create.call(hook(production));
    const testing = { ...production };
    const ctx = hookContext({
      params: { base: rl(api.baseId), events: ['record.created'], tableIds: [] },
      credentials,
      staticData: testing,
      webhookUrl: 'https://n8n.example.com/webhook-test/abc/webhook',
    });
    expect(await hooks.checkExists.call(ctx)).toBe(false);
    expect(await hooks.create.call(ctx)).toBe(true);
    expect(api.webhooks.map((h) => h.url)).toEqual([
      webhookUrl,
      'https://n8n.example.com/webhook-test/abc/webhook',
    ]);
    expect(await hooks.delete.call(ctx)).toBe(true);
    expect(api.webhooks.map((h) => h.id)).toEqual([production['webhookId']]);
    expect(await hooks.checkExists.call(hook(production))).toBe(true);
  });

  it('deactivates cleanly when the webhook was already deleted', async () => {
    const staticData: IDataObject = {};
    await hooks.create.call(hook(staticData));
    api.webhooks.length = 0;
    expect(await hooks.delete.call(hook(staticData))).toBe(true);
    expect(staticData).toEqual({});
  });

  it("surfaces the API's refusal (a URL it won't deliver to)", async () => {
    api.answerNext(422, {
      error: { type: 'INVALID_REQUEST_UNKNOWN', message: 'The URL must use https.', code: 'X' },
    });
    await expect(hooks.create.call(hook({}))).rejects.toThrow('The URL must use https.');
  });

  it("loads the base's tables for the table filter", async () => {
    const ctx = loadOptionsContext({ params: { base: rl(api.baseId) }, credentials });
    expect(await trigger.methods.loadOptions.getTables.call(ctx)).toEqual([
      { name: 'Tasks', value: api.tasks.id },
      { name: 'Numbers only', value: api.empty.id },
    ]);
  });

  describe('deliveries', () => {
    const nameId = '11111111-1111-7111-8111-111111111111';
    const statusId = '22222222-2222-7222-8222-222222222222';
    const payload = {
      id: 'evt-1',
      type: 'record.updated',
      timestamp: '2026-10-26T10:00:00.000Z',
      webhookId: 'wh-1',
      base: { id: 'b-1', name: 'Roadmap' },
      table: { id: 't-1', name: 'Tasks' },
      record: {
        id: 'r-1',
        before: { [statusId]: 'Todo' },
        after: { [statusId]: 'Shipped' },
      },
      fields: {
        [nameId]: { name: 'Name', type: 'singleLineText' },
        [statusId]: { name: 'Status', type: 'singleSelect' },
      },
      actor: { id: 'u-1', name: 'Ada' },
    };
    const deliver = (
      body: string,
      headers: Record<string, string>,
      params: Record<string, unknown> = { simplify: true },
      secret = SECRET
    ) =>
      webhookContext({
        params,
        staticData: secret ? { webhookId: 'wh-1', baseId: 'b-1', secret } : {},
        rawBody: Buffer.from(body),
        headers,
      });

    it('starts the workflow with a verified event, cells by field name', async () => {
      const body = JSON.stringify(payload);
      const { context, responded } = deliver(body, { 'x-openrows-signature': sign(body) });
      const result = await trigger.webhook.call(context);
      expect(responded).toEqual({});
      expect(result.workflowData).toEqual([
        [
          {
            json: {
              event: 'record.updated',
              eventId: 'evt-1',
              timestamp: '2026-10-26T10:00:00.000Z',
              baseId: 'b-1',
              baseName: 'Roadmap',
              tableId: 't-1',
              tableName: 'Tasks',
              recordId: 'r-1',
              fields: { Status: 'Shipped' },
              previousFields: { Status: 'Todo' },
              changedFields: ['Status'],
              actor: { id: 'u-1', name: 'Ada' },
              webhookId: 'wh-1',
            },
          },
        ],
      ]);
    });

    it('passes the raw payload through without simplify', async () => {
      const body = JSON.stringify(payload);
      const { context } = deliver(
        body,
        { 'x-openrows-signature': sign(body) },
        { simplify: false }
      );
      expect((await trigger.webhook.call(context)).workflowData).toEqual([[{ json: payload }]]);
    });

    it('answers 401 and starts nothing for a bad, stale or missing signature', async () => {
      const body = JSON.stringify(payload);
      for (const headers of [
        {} as Record<string, string>,
        { 'x-openrows-signature': sign(body, now(), 'whsec_wrong') },
        { 'x-openrows-signature': sign(body, now() - 600) },
        { 'x-openrows-signature': sign(`${body} `) },
      ]) {
        const { context, responded } = deliver(body, headers);
        const result = await trigger.webhook.call(context);
        expect(result).toEqual({ noWebhookResponse: true });
        expect(responded).toEqual({ status: 401, body: 'Invalid signature' });
      }
    });

    it('refuses everything while it has no secret (not registered by this node)', async () => {
      const body = JSON.stringify(payload);
      const { context, responded } = deliver(
        body,
        { 'x-openrows-signature': sign(body) },
        { simplify: true },
        ''
      );
      expect(await trigger.webhook.call(context)).toEqual({ noWebhookResponse: true });
      expect(responded.status).toBe(401);
    });

    it('answers a ping without starting the workflow', async () => {
      const body = JSON.stringify({ ...payload, type: 'ping', record: undefined });
      const { context } = deliver(body, { 'x-openrows-signature': sign(body) });
      expect(await trigger.webhook.call(context)).toEqual({ webhookResponse: 'OK' });
    });

    it('answers 400 to a signed body that is not an event', async () => {
      for (const body of ['not json', '{"hello":1}']) {
        const { context, responded } = deliver(body, { 'x-openrows-signature': sign(body) });
        expect(await trigger.webhook.call(context)).toEqual({ noWebhookResponse: true });
        expect(responded.status).toBe(400);
      }
    });
  });
});

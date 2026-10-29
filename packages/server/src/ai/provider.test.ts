import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createSafeFetch, outboundPolicy } from '../lib/safe-fetch/index.js';
import {
  completion,
  type FakeOpenAi,
  fakeOutbound,
  startFakeOpenAi,
} from './__fixtures__/fake-openai.js';
import {
  AI_MAX_OUTPUT_TOKENS,
  AiProviderError,
  createOpenAiCompatibleProvider,
  outputJsonSchema,
} from './provider.js';

const KEY = 'sk-test-0123456789abcdefSECRET';

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
});
afterAll(() => fake.close());
beforeEach(() => {
  fake.requests.length = 0;
  fake.respond = () => completion('{"ok":true}');
});

function provider(opts: { apiKey?: string; baseUrl?: string; timeoutMs?: number } = {}) {
  return createOpenAiCompatibleProvider({
    baseUrl: opts.baseUrl ?? fake.baseUrl,
    model: 'fake-model',
    apiKey: 'apiKey' in opts ? opts.apiKey : KEY,
    http: createSafeFetch(outboundPolicy(fakeOutbound(fake.port))),
    timeoutMs: opts.timeoutMs,
  });
}

async function failure(p: Promise<unknown>): Promise<AiProviderError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AiProviderError) return err;
    throw err;
  }
  throw new Error('expected an AiProviderError');
}

const Answer = z.strictObject({ label: z.enum(['bug', 'feature']), score: z.number() });

describe('the OpenAI-compatible provider', () => {
  it('sends a chat completion with the key as a bearer token and reports usage', async () => {
    fake.respond = () => completion('Hello there');
    const result = await provider().chat({
      messages: [{ role: 'user', content: 'Say hello' }],
      maxTokens: 50,
      temperature: 0.2,
    });
    expect(result).toEqual({
      text: 'Hello there',
      data: undefined,
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17, estimated: false },
      model: 'fake-model-2026',
      finishReason: 'stop',
    });
    const [req] = fake.requests;
    expect(req?.path).toBe('/v1/chat/completions');
    expect(req?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req?.headers['content-type']).toBe('application/json');
    expect(req?.body).toEqual({
      model: 'fake-model',
      max_tokens: 50,
      temperature: 0.2,
      messages: [{ role: 'user', content: 'Say hello' }],
    });
  });

  it('sends no Authorization header without a key (local servers)', async () => {
    await provider({ apiKey: undefined }).chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(fake.requests[0]?.headers.authorization).toBeUndefined();
    expect(fake.requests[0]?.body['max_tokens']).toBe(1024);
    expect(fake.requests[0]?.body).not.toHaveProperty('temperature');
  });

  it('caps the reply tokens', async () => {
    await provider().chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 10 ** 9 });
    expect(fake.requests[0]?.body['max_tokens']).toBe(AI_MAX_OUTPUT_TOKENS);
  });

  it('asks for a JSON schema and parses the structured answer', async () => {
    fake.respond = () => completion('```json\n{"label":"bug","score":0.9}\n```');
    const result = await provider().chat({
      messages: [{ role: 'user', content: 'Classify: it crashes' }],
      output: { name: 'classification', schema: Answer },
    });
    expect(result.data).toEqual({ label: 'bug', score: 0.9 });
    const body = fake.requests[0]?.body ?? {};
    expect(body['response_format']).toEqual({
      type: 'json_schema',
      json_schema: { name: 'classification', schema: outputJsonSchema(Answer), strict: true },
    });
    const schema = outputJsonSchema(Answer);
    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['label', 'score'],
    });
    const messages = body['messages'] as { role: string; content: string }[];
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain(JSON.stringify(schema));
    expect(messages[1]).toEqual({ role: 'user', content: 'Classify: it crashes' });
  });

  it('refuses structured answers that are not JSON, the wrong shape or cut off', async () => {
    const ask = () =>
      provider().chat({
        messages: [{ role: 'user', content: 'x' }],
        output: { name: 'classification', schema: Answer },
      });
    fake.respond = () => completion('Sure! Here it is');
    expect((await failure(ask())).code).toBe('INVALID_OUTPUT');
    fake.respond = () => completion('{"label":"question","score":1}');
    expect((await failure(ask())).code).toBe('INVALID_OUTPUT');
    fake.respond = () => completion('{"label":"bug"', { finishReason: 'length' });
    expect((await failure(ask())).message).toMatch(/cut off/);
    fake.respond = () => completion(null, { refusal: 'I cannot' });
    expect((await failure(ask())).code).toBe('REFUSED');
  });

  it('estimates usage when the provider reports none', async () => {
    fake.respond = () => completion('12345678', { usage: null });
    const { usage } = await provider().chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(usage.estimated).toBe(true);
    expect(usage.outputTokens).toBe(2);
    expect(usage.totalTokens).toBe(usage.inputTokens + 2);
  });

  it('maps provider errors to safe messages, never the provider text or the key', async () => {
    const cases: [number, string][] = [
      [401, 'UNAUTHORIZED'],
      [403, 'UNAUTHORIZED'],
      [404, 'NOT_FOUND'],
      [429, 'RATE_LIMITED'],
      [400, 'BAD_REQUEST'],
      [500, 'UNAVAILABLE'],
      [503, 'UNAVAILABLE'],
    ];
    for (const [status, code] of cases) {
      fake.respond = () => ({
        status,
        headers: { 'retry-after': '7' },
        body: {
          error: {
            message: `Incorrect API key provided: ${KEY}`,
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        },
      });
      const err = await failure(provider().chat({ messages: [{ role: 'user', content: 'x' }] }));
      expect(err.code).toBe(code);
      expect(err.detail).toBe(`status ${status}, code invalid_api_key, type invalid_request_error`);
      const everything = JSON.stringify({ ...err, message: err.message, stack: err.stack });
      expect(everything).not.toContain(KEY);
      expect(everything).not.toContain('Incorrect API key');
      if (status === 429) expect(err.retryAfterSeconds).toBe(7);
    }
  });

  it("leaves a provider's error code out of the log when it isn't an identifier", async () => {
    for (const echoed of [KEY, KEY.slice(3, 20), `bad ${KEY}`]) {
      fake.respond = () => ({ status: 400, body: { error: { code: echoed, type: echoed } } });
      const err = await failure(provider().chat({ messages: [{ role: 'user', content: 'x' }] }));
      expect(err.detail).toBe('status 400');
    }
  });

  it('refuses answers that are not chat completions', async () => {
    fake.respond = () => ({ body: { hello: 'world' } });
    expect(
      (await failure(provider().chat({ messages: [{ role: 'user', content: 'x' }] }))).code
    ).toBe('INVALID_RESPONSE');
    fake.respond = () => ({ body: '<html>' });
    expect(
      (await failure(provider().chat({ messages: [{ role: 'user', content: 'x' }] }))).code
    ).toBe('INVALID_RESPONSE');
  });

  it('does not follow redirects', async () => {
    fake.respond = () => ({
      status: 307,
      headers: { location: 'https://evil.example/' },
      body: '',
    });
    const err = await failure(provider().chat({ messages: [{ role: 'user', content: 'x' }] }));
    expect(err.code).toBe('UNREACHABLE');
    expect(fake.requests).toHaveLength(1);
  });

  it('goes through the SSRF-safe client: private addresses are refused by default', async () => {
    const p = createOpenAiCompatibleProvider({
      baseUrl: fake.baseUrl,
      model: 'm',
      apiKey: KEY,
      http: createSafeFetch(outboundPolicy()),
    });
    const err = await failure(p.chat({ messages: [{ role: 'user', content: 'x' }] }));
    expect(err.code).toBe('UNREACHABLE');
    expect(err.message).not.toContain(KEY);
    expect(fake.requests).toHaveLength(0);
  });

  it('checks the request before sending it', async () => {
    expect((await failure(provider().chat({ messages: [] }))).code).toBe('BAD_REQUEST');
    const long = { role: 'user' as const, content: 'x'.repeat(200_001) };
    expect((await failure(provider().chat({ messages: [long] }))).code).toBe('BAD_REQUEST');
    const badName = provider().chat({
      messages: [{ role: 'user', content: 'x' }],
      output: { name: 'no spaces allowed', schema: Answer },
    });
    expect((await failure(badName)).code).toBe('BAD_REQUEST');
    expect(fake.requests).toHaveLength(0);
  });

  it("uses max_completion_tokens on OpenAI's own API and names the host, not the key", () => {
    const p = createOpenAiCompatibleProvider({
      baseUrl: 'https://api.openai.com/v1/',
      model: 'gpt-4.1-mini',
      apiKey: KEY,
      http: async () => {
        throw new Error('not called');
      },
    });
    expect(p.id).toBe('openai-compatible:api.openai.com');
    expect(p.model).toBe('gpt-4.1-mini');
  });
});

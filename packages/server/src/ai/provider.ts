import { z } from 'zod';
import { type SafeFetch, SafeFetchError } from '../lib/safe-fetch/index.js';

/**
 * The AI provider abstraction: chat completions with optional structured (JSON schema)
 * output and the tokens each request used. AI fields and the assistant call it;
 * the hosted edition meters the tokens through the edition's UsageMeter (`aiTokens`).
 *
 * The one implementation speaks the OpenAI chat completions API, which OpenAI, Anthropic's
 * OpenAI-compatible endpoint, OpenRouter, Ollama and most local servers accept. Requests go
 * through the SSRF-safe client. The API key is only ever put in the Authorization
 * header: errors, logs and results never carry it, nor the provider's own error text (which can
 * quote the key back, "Incorrect API key provided: sk-…").
 */

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Structured output: the reply must be JSON that `schema` accepts. */
export interface AiOutput<T> {
  /** A name for the schema, letters, digits, `_` and `-` (OpenAI's `json_schema.name`). */
  name: string;
  /**
   * Use strict objects (`z.strictObject`) with every property required (nullable instead of
   * optional): OpenAI's strict structured outputs need that.
   */
  schema: z.ZodType<T>;
}

export interface AiChatRequest<T = undefined> {
  messages: readonly AiMessage[];
  output?: AiOutput<T>;
  /** The reply's cap in tokens (default 1,024, at most AI_MAX_OUTPUT_TOKENS). */
  maxTokens?: number;
  /** Omitted: the model's default (some models refuse any other). */
  temperature?: number;
  signal?: AbortSignal;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** True when the provider reported no usage and the counts are estimated from the text. */
  estimated: boolean;
}

export interface AiChatResult<T = undefined> {
  /** The reply's text (the JSON itself with structured output). */
  text: string;
  /** The parsed reply with structured output; undefined without. */
  data: T;
  usage: AiUsage;
  /** The model that answered, as the provider names it. */
  model: string;
  finishReason: string | null;
}

export interface AiProvider {
  /** For logs: the provider kind and host, never the key. */
  readonly id: string;
  readonly model: string;
  chat<T = undefined>(request: AiChatRequest<T>): Promise<AiChatResult<T>>;
}

export type AiErrorCode =
  | 'UNREACHABLE'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'INVALID_OUTPUT'
  | 'REFUSED'
  | 'QUOTA_EXCEEDED'
  | 'ABORTED';

/**
 * A request that failed. `message` is safe to show the workspace's owners; `detail` is for the
 * server's log (status, the provider's error code or type), never the provider's message, the
 * request or the key.
 */
export class AiProviderError extends Error {
  override name = 'AiProviderError';
  constructor(
    readonly code: AiErrorCode,
    message: string,
    readonly detail?: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
  }
}

export const AI_DEFAULT_OUTPUT_TOKENS = 1024;
export const AI_MAX_OUTPUT_TOKENS = 8192;
/** A request's messages, in characters: about 50k tokens. */
export const AI_MAX_INPUT_CHARS = 200_000;
export const AI_MAX_MESSAGES = 100;
export const AI_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

export interface OpenAiCompatibleOptions {
  /** Up to the version segment: `https://api.openai.com/v1`; `/chat/completions` is appended. */
  baseUrl: string;
  model: string;
  /** Empty or undefined: no Authorization header (Ollama and other local servers). */
  apiKey: string | undefined;
  /** The SSRF-safe client with the rules for this provider's URL. */
  http: SafeFetch;
  timeoutMs?: number;
}

const responseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          refusal: z.string().nullable().optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      })
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().min(0).optional(),
      completion_tokens: z.number().int().min(0).optional(),
      total_tokens: z.number().int().min(0).optional(),
    })
    .nullable()
    .optional(),
});

const providerErrorSchema = z.object({
  error: z.object({
    code: z.union([z.string(), z.number()]).nullable().optional(),
    type: z.string().nullable().optional(),
  }),
});

/**
 * Short, identifier-like strings only: a provider's `code`/`type` for the log. Anything that
 * contains the key, or a part of it, is left out.
 */
function logToken(value: unknown, apiKey: string | undefined): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const s = String(value);
  if (!/^[\w.-]{1,64}$/.test(s)) return undefined;
  if (apiKey && (s.includes(apiKey) || (s.length >= 8 && apiKey.includes(s)))) return undefined;
  return s;
}

function errorDetail(status: number, body: string, apiKey: string | undefined): string {
  let parsed: z.infer<typeof providerErrorSchema> | undefined;
  try {
    const r = providerErrorSchema.safeParse(JSON.parse(body));
    if (r.success) parsed = r.data;
  } catch {
    // Not JSON: the status alone.
  }
  const parts = [`status ${status}`];
  const code = logToken(parsed?.error.code, apiKey);
  const type = logToken(parsed?.error.type, apiKey);
  if (code) parts.push(`code ${code}`);
  if (type) parts.push(`type ${type}`);
  return parts.join(', ');
}

function statusError(
  status: number,
  body: string,
  headers: Headers,
  apiKey: string | undefined
): AiProviderError {
  const detail = errorDetail(status, body, apiKey);
  if (status === 401 || status === 403) {
    return new AiProviderError('UNAUTHORIZED', 'The provider refused the API key.', detail);
  }
  if (status === 404) {
    return new AiProviderError(
      'NOT_FOUND',
      "The provider doesn't know this model or URL. Check both.",
      detail
    );
  }
  if (status === 429) {
    const retry = Number(headers.get('retry-after'));
    return new AiProviderError(
      'RATE_LIMITED',
      'The provider is rate limiting requests, or the account is out of credit. Try again later.',
      detail,
      Number.isFinite(retry) && retry > 0 ? Math.min(Math.ceil(retry), 3600) : undefined
    );
  }
  if (status >= 400 && status < 500) {
    return new AiProviderError(
      'BAD_REQUEST',
      'The provider refused the request. Check the model name.',
      detail
    );
  }
  return new AiProviderError('UNAVAILABLE', "The provider didn't answer. Try again later.", detail);
}

/** A rough count when the provider reports none: about 4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function stripFences(text: string): string {
  const t = text.trim();
  const m = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(t);
  return m?.[1]?.trim() ?? t;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'invalid';
  }
}

/** The JSON schema of a structured output, as sent to the provider. */
export function outputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'any' });
  const { $schema: _drop, ...rest } = json as Record<string, unknown>;
  return rest;
}

const OUTPUT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): AiProvider {
  const base = options.baseUrl.replace(/\/+$/, '');
  const endpoint = `${base}/chat/completions`;
  const host = hostOf(base);
  // OpenAI's newer models refuse `max_tokens`; other servers only know it.
  const maxTokensParam = host === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens';
  const apiKey = options.apiKey?.trim() || undefined;

  return {
    id: `openai-compatible:${host}`,
    model: options.model,
    async chat<T = undefined>(request: AiChatRequest<T>): Promise<AiChatResult<T>> {
      const messages = [...request.messages];
      if (messages.length === 0 || messages.length > AI_MAX_MESSAGES) {
        throw new AiProviderError('BAD_REQUEST', `Send 1 to ${AI_MAX_MESSAGES} messages.`);
      }
      const inputChars = messages.reduce((n, m) => n + m.content.length, 0);
      if (inputChars > AI_MAX_INPUT_CHARS) {
        throw new AiProviderError('BAD_REQUEST', 'The request is too long for the AI provider.');
      }
      const maxTokens = Math.max(
        1,
        Math.min(AI_MAX_OUTPUT_TOKENS, Math.floor(request.maxTokens ?? AI_DEFAULT_OUTPUT_TOKENS))
      );

      const body: Record<string, unknown> = {
        model: options.model,
        [maxTokensParam]: maxTokens,
      };
      if (request.temperature !== undefined) {
        body['temperature'] = Math.max(0, Math.min(2, request.temperature));
      }
      if (request.output) {
        if (!OUTPUT_NAME.test(request.output.name)) {
          throw new AiProviderError('BAD_REQUEST', 'The output name is not valid.');
        }
        const schema = outputJsonSchema(request.output.schema);
        body['response_format'] = {
          type: 'json_schema',
          json_schema: { name: request.output.name, schema, strict: true },
        };
        // Some compatible servers ignore response_format: the instruction says it as well.
        messages.unshift({
          role: 'system',
          content: `Reply with one JSON value only, no prose and no code fences, valid against this JSON schema:\n${JSON.stringify(schema)}`,
        });
      }
      body['messages'] = messages;

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
      };
      if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

      const started = Date.now();
      let res: Awaited<ReturnType<SafeFetch>>;
      try {
        res = await options.http(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          // A redirect would carry the request (and the key, same origin) elsewhere.
          maxRedirects: 0,
          maxBytes: AI_RESPONSE_MAX_BYTES,
          timeoutMs: options.timeoutMs ?? 60_000,
          signal: request.signal,
        });
      } catch (err) {
        if (err instanceof SafeFetchError) {
          if (err.code === 'ABORTED') {
            throw new AiProviderError('ABORTED', 'The request was cancelled.');
          }
          if (err.code === 'TIMEOUT') {
            throw new AiProviderError(
              'UNAVAILABLE',
              "The provider didn't answer in time.",
              `timeout after ${Date.now() - started} ms`
            );
          }
          if (err.code === 'RESPONSE_TOO_LARGE') {
            throw new AiProviderError(
              'INVALID_RESPONSE',
              "The provider's answer was too large.",
              err.code
            );
          }
          // SafeFetchError messages are safe to show (no resolved addresses).
          throw new AiProviderError(
            'UNREACHABLE',
            `Couldn't reach the provider: ${err.message}`,
            err.code
          );
        }
        throw new AiProviderError('UNREACHABLE', "Couldn't reach the provider.", 'fetch failed');
      }

      if (res.status >= 300 && res.status < 400) {
        throw new AiProviderError(
          'BAD_REQUEST',
          'The provider redirected the request. Use the final URL.',
          `status ${res.status}`
        );
      }
      if (res.status < 200 || res.status >= 300) {
        throw statusError(res.status, res.text(), res.headers, apiKey);
      }

      let parsed: z.infer<typeof responseSchema>;
      try {
        const r = responseSchema.safeParse(JSON.parse(res.text()));
        if (!r.success) throw r.error;
        parsed = r.data;
      } catch {
        throw new AiProviderError(
          'INVALID_RESPONSE',
          "The provider's answer isn't an OpenAI-compatible chat completion.",
          `status ${res.status}`
        );
      }
      const choice = parsed.choices[0];
      if (!choice) {
        throw new AiProviderError('INVALID_RESPONSE', 'The provider answered nothing.');
      }
      const text = choice.message.content ?? '';
      const finishReason = choice.finish_reason ?? null;
      if (choice.message.refusal) {
        throw new AiProviderError('REFUSED', 'The model declined to answer.', 'refusal');
      }

      const reported = parsed.usage;
      const inputTokens = reported?.prompt_tokens ?? estimateTokens(JSON.stringify(messages));
      const outputTokens = reported?.completion_tokens ?? estimateTokens(text);
      const usage: AiUsage = {
        inputTokens,
        outputTokens,
        totalTokens: reported?.total_tokens ?? inputTokens + outputTokens,
        estimated:
          reported?.prompt_tokens === undefined || reported.completion_tokens === undefined,
      };
      const model = parsed.model ?? options.model;

      if (!request.output) {
        return { text, data: undefined as T, usage, model, finishReason };
      }
      if (finishReason === 'length') {
        throw new AiProviderError(
          'INVALID_OUTPUT',
          'The answer was cut off before it was complete.',
          'finish_reason length'
        );
      }
      let json: unknown;
      try {
        json = JSON.parse(stripFences(text));
      } catch {
        throw new AiProviderError(
          'INVALID_OUTPUT',
          "The model's answer wasn't valid JSON.",
          'json parse'
        );
      }
      const checked = request.output.schema.safeParse(json);
      if (!checked.success) {
        throw new AiProviderError(
          'INVALID_OUTPUT',
          "The model's answer didn't match the expected shape.",
          'schema mismatch'
        );
      }
      return { text, data: checked.data, usage, model, finishReason };
    },
  };
}

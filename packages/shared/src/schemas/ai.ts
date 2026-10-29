import { z } from 'zod';

/**
 * AI providers: an OpenAI-compatible chat completions API (OpenAI, Anthropic's
 * OpenAI-compatible endpoint, OpenRouter, Ollama and other local servers), configured for the
 * whole instance (AI_* in the server's env) and optionally per workspace, where an owner brings
 * their own key in Settings → AI. A key is write-only: it's encrypted at rest, and no response
 * carries it or any part of it.
 */

/** The longest API key accepted (OpenAI's are about 170 characters; JWT-style keys are longer). */
export const AI_KEY_MAX = 512;
export const AI_MODEL_MAX = 200;
export const AI_BASE_URL_MAX = 500;

/** Where AI features get their provider: the workspace's own key, the instance's, or none. */
export const AI_SOURCES = ['workspace', 'instance'] as const;
export type AiSource = (typeof AI_SOURCES)[number];

/** Well-known OpenAI-compatible endpoints, the settings form's presets. */
export const AI_PRESETS = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-haiku-5-5',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4.1-mini',
  },
] as const;

/** The default endpoint when a workspace names none. */
export const AI_DEFAULT_BASE_URL = AI_PRESETS[0].baseUrl;

// Printable ASCII, no spaces: what a bearer token can carry in a header.
const keySchema = z
  .string()
  .min(8, 'too short for an API key')
  .max(AI_KEY_MAX)
  .regex(/^[\x21-\x7e]+$/, 'letters, digits and symbols only, no spaces');

export const aiBaseUrlSchema = z
  .url({ protocol: /^https?$/, message: 'an http(s) URL' })
  .max(AI_BASE_URL_MAX)
  .refine((u) => {
    const url = new URL(u);
    return url.username === '' && url.password === '' && url.search === '' && url.hash === '';
  }, 'no credentials, query or fragment in the URL');

export const aiModelSchema = z
  .string()
  .trim()
  .min(1)
  .max(AI_MODEL_MAX)
  .regex(/^[\x21-\x7e]+$/, 'no spaces');

/**
 * `PUT /api/workspaces/:workspaceId/ai/settings`: the workspace's provider. `apiKey` omitted
 * keeps the stored key (changing the URL or model without retyping it); a workspace without a
 * stored key must send one.
 */
export const updateAiSettingsSchema = z
  .object({
    /** null or omitted: OpenAI's API. */
    baseUrl: aiBaseUrlSchema.nullable().optional(),
    model: aiModelSchema,
    apiKey: keySchema.optional(),
  })
  .strict();
export type UpdateAiSettings = z.infer<typeof updateAiSettingsSchema>;

/** The workspace's own provider, as owners see it: never the key, only whether one is stored. */
export const WorkspaceAiConfigSchema = z.object({
  baseUrl: z.string(),
  model: z.string(),
  hasKey: z.boolean(),
  updatedAt: z.string(),
});
export type WorkspaceAiConfig = z.infer<typeof WorkspaceAiConfigSchema>;

/** `GET /api/workspaces/:workspaceId/ai/settings` (owners). */
export const AiSettingsSchema = z.object({
  workspaceId: z.string(),
  /** What AI features use now; null: AI is off (hidden) in this workspace. */
  source: z.enum(AI_SOURCES).nullable(),
  /** The instance's provider (AI_MODEL); its URL and key stay with the operator. */
  instance: z.object({
    available: z.boolean(),
    model: z.string().nullable(),
    /**
     * This month's AI credits on it (the hosted service's managed AI), when the plan
     * limits them; null: not limited. A workspace's own key never uses them.
     */
    credits: z
      .object({
        used: z.number().int().min(0),
        limit: z.number().int().min(0),
        resetsOn: z.iso.date(),
      })
      .nullable()
      .optional(),
  }),
  workspace: WorkspaceAiConfigSchema.nullable(),
  /**
   * The hostnames a workspace's base URL may use (AI_ALLOWED_HOSTS, `*.` wildcards); null: any
   * host the outbound rules allow.
   */
  allowedHosts: z.array(z.string()).nullable(),
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

/** `GET /api/workspaces/:workspaceId/ai` (members): whether to show AI features at all. */
export const AiAvailabilitySchema = z.object({
  workspaceId: z.string(),
  available: z.boolean(),
  source: z.enum(AI_SOURCES).nullable(),
});
export type AiAvailability = z.infer<typeof AiAvailabilitySchema>;

/** `POST /api/workspaces/:workspaceId/ai/settings/test` (owners): one small structured request. */
export const AiTestResultSchema = z.object({
  ok: z.boolean(),
  source: z.enum(AI_SOURCES),
  model: z.string(),
  /** What went wrong, safe to show (never the provider's own message or the key). */
  error: z.string().nullable(),
  usage: z
    .object({
      inputTokens: z.number().int().min(0),
      outputTokens: z.number().int().min(0),
      totalTokens: z.number().int().min(0),
    })
    .nullable(),
  latencyMs: z.number().int().min(0),
});
export type AiTestResult = z.infer<typeof AiTestResultSchema>;

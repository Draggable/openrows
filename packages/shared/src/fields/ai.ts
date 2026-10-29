import { z } from 'zod';
import { choiceSchema } from './choices.js';

/**
 * AI fields (Airtable's field agents): a prompt template over the record's other fields,
 * answered by the workspace's AI provider in the worker, one record at a time. The prompt
 * names fields with `{Field name}` tokens; the server stores them by id (`{<field id>}`, like a
 * formula's stored form), so renaming a field keeps the prompt. `\{` and `\}` are literal braces.
 */

/** What the provider's answer becomes: a text, one of the field's choices, a number, a summary. */
export const AI_FIELD_OUTPUTS = ['text', 'singleSelect', 'number', 'summary'] as const;
export type AiFieldOutput = (typeof AI_FIELD_OUTPUTS)[number];

export const AI_FIELD_OUTPUT_LABELS: Record<AiFieldOutput, string> = {
  text: 'Text',
  singleSelect: 'Single select',
  number: 'Number',
  summary: 'Summary',
};

/** The longest prompt template, in characters. */
export const AI_PROMPT_MAX = 10_000;
/** Most fields one prompt references. */
export const AI_PROMPT_MAX_FIELDS = 50;
/** Most choices of a single-select AI field (the provider gets them all in the request). */
export const AI_MAX_CHOICES = 100;
/** The longest generated text or summary kept in a cell. */
export const AI_MAX_TEXT = 10_000;
/** The longest value of one referenced field in a prompt; longer ones are cut. */
export const AI_MAX_INPUT_VALUE = 20_000;

/** The per-record generation states (`ai_field_cells`). */
export const AI_CELL_STATUSES = ['pending', 'done', 'error', 'canceled'] as const;
export type AiCellStatus = (typeof AI_CELL_STATUSES)[number];

export const aiOptionsSchema = z
  .object({
    /**
     * The prompt template. Clients send it with `{Field name}` tokens (or in the stored form);
     * the server stores fields by id (`storeAiPrompt`).
     */
    prompt: z.string().max(AI_PROMPT_MAX).default(''),
    output: z.enum(AI_FIELD_OUTPUTS).default('text'),
    /** A single-select output's options: the answer is always one of them, or empty. */
    choices: z.array(choiceSchema).max(AI_MAX_CHOICES).default([]),
    /** Decimals of a number output (`null`: as answered, up to 8). */
    precision: z.int().min(0).max(8).nullable().default(null),
    /** Set by the server from the prompt: the fields it reads. */
    referencedFieldIds: z.array(z.uuid()).max(AI_PROMPT_MAX_FIELDS).default([]),
    /** Generate again when a referenced field changes (debounced, in the worker). */
    autoUpdate: z.boolean().default(true),
  })
  .strict()
  .refine((o) => new Set(o.choices.map((c) => c.id)).size === o.choices.length, {
    message: 'Choice ids must be unique',
    path: ['choices'],
  });

export type AiOptions = z.infer<typeof aiOptionsSchema>;

/** A piece of a prompt template: literal text or a field token (its text: a name or an id). */
export type AiPromptPart = { text: string } | { token: string };

/** Splits a template into text and `{…}` tokens; `\{` and `\}` are literal. Never throws. */
export function parseAiPrompt(prompt: string): AiPromptPart[] {
  const parts: AiPromptPart[] = [];
  let text = '';
  let i = 0;
  while (i < prompt.length) {
    const ch = prompt[i] as string;
    if (ch === '\\' && (prompt[i + 1] === '{' || prompt[i + 1] === '}')) {
      text += prompt[i + 1];
      i += 2;
      continue;
    }
    if (ch === '{') {
      const end = prompt.indexOf('}', i + 1);
      if (end !== -1) {
        if (text) parts.push({ text });
        text = '';
        parts.push({ token: prompt.slice(i + 1, end).trim() });
        i = end + 1;
        continue;
      }
    }
    text += ch;
    i++;
  }
  if (text) parts.push({ text });
  return parts;
}

const escapeText = (text: string) => text.replace(/[{}]/g, (c) => `\\${c}`);

export interface AiPromptField {
  id: string;
  name: string;
}

export type StoredAiPrompt =
  | { ok: true; prompt: string; referencedFieldIds: string[] }
  | { ok: false; message: string };

/**
 * The stored form of a template: each token resolved to a field of `fields` (by id, then name,
 * then case-insensitive name) and written as `{<id>}`. A token naming no field fails.
 */
export function storeAiPrompt(prompt: string, fields: readonly AiPromptField[]): StoredAiPrompt {
  let out = '';
  const ids: string[] = [];
  for (const part of parseAiPrompt(prompt)) {
    if ('text' in part) {
      out += escapeText(part.text);
      continue;
    }
    const lower = part.token.toLowerCase();
    const field =
      fields.find((f) => f.id === part.token) ??
      fields.find((f) => f.name === part.token) ??
      fields.find((f) => f.name.toLowerCase() === lower);
    if (!field) {
      return {
        ok: false,
        message: part.token
          ? `No field named "${part.token}". Write \\{ for a literal brace.`
          : 'Empty field token {}. Write \\{ for a literal brace.',
      };
    }
    out += `{${field.id}}`;
    if (!ids.includes(field.id)) ids.push(field.id);
  }
  if (ids.length > AI_PROMPT_MAX_FIELDS) {
    return { ok: false, message: `A prompt can reference at most ${AI_PROMPT_MAX_FIELDS} fields.` };
  }
  return { ok: true, prompt: out, referencedFieldIds: ids };
}

/** A stored template with field names (`{Name}`) for editing; unknown ids stay as they are. */
export function displayAiPrompt(stored: string, fields: readonly AiPromptField[]): string {
  let out = '';
  for (const part of parseAiPrompt(stored)) {
    if ('text' in part) out += escapeText(part.text);
    else out += `{${fields.find((f) => f.id === part.token)?.name ?? part.token}}`;
  }
  return out;
}

/** A stored template filled in: each token replaced by `read(field id)` (cut to a cap). */
export function renderAiPrompt(stored: string, read: (fieldId: string) => string): string {
  let out = '';
  for (const part of parseAiPrompt(stored)) {
    if ('text' in part) out += part.text;
    else out += read(part.token).slice(0, AI_MAX_INPUT_VALUE);
  }
  return out;
}

/** One AI field's generation state, as `GET /api/fields/:fieldId/ai` answers it. */
export const AiFieldStatusSchema = z.object({
  fieldId: z.uuid(),
  /** Whether the workspace has an AI provider (generation waits for one). */
  available: z.boolean(),
  counts: z.object({
    pending: z.number().int().min(0),
    done: z.number().int().min(0),
    error: z.number().int().min(0),
    canceled: z.number().int().min(0),
  }),
  /** Records not done (pending, error, canceled), oldest request first, at most `limit`. */
  cells: z.array(
    z.object({
      recordId: z.uuid(),
      status: z.enum(AI_CELL_STATUSES),
      error: z.string().nullable(),
      updatedAt: z.string(),
    })
  ),
});
export type AiFieldStatus = z.infer<typeof AiFieldStatusSchema>;

/** Most records one status answer lists, and one generate request names. */
export const AI_STATUS_CELLS_MAX = 1000;
export const AI_GENERATE_RECORDS_MAX = 1000;

export const aiGenerateSchema = z.union([
  z.strictObject({ recordIds: z.array(z.uuid()).min(1).max(AI_GENERATE_RECORDS_MAX) }),
  /** Every record (`all`), or those without a value or with an error (`missing`): creators. */
  z.strictObject({ scope: z.enum(['all', 'missing']) }),
]);
export type AiGenerateInput = z.infer<typeof aiGenerateSchema>;

export const AiGenerateResultSchema = z.object({ queued: z.number().int().min(0) });
export const AiCancelResultSchema = z.object({ canceled: z.number().int().min(0) });

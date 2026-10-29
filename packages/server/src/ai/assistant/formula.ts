import {
  type AssistantFieldInfo,
  checkFormulaSuggestion,
  type FormulaType,
} from '@openrows/shared';
import { z } from 'zod';
import type { AiMessage, AiProvider } from '../provider.js';
import { formulaSystemPrompt } from './prompt.js';

/**
 * Formula generation: the model writes a formula for a description, the shared parser and
 * type checker validate it, and on an error the model gets the error and one more try. The
 * assistant's plans check their formulas the same way; the evals (`evals/formula/`) measure this.
 */

export const formulaAnswerSchema = z.strictObject({
  formula: z.string(),
  explanation: z.string(),
});

export interface FormulaRequest {
  /** The table's fields, by name as the user sees them. */
  fields: readonly AssistantFieldInfo[];
  /** What the formula should compute. */
  prompt: string;
  /** Requests at most (default 2: the first answer and one retry on a type error). */
  maxAttempts?: number;
  signal?: AbortSignal;
}

export type FormulaSuggestion =
  | { ok: true; formula: string; type: FormulaType; explanation: string; attempts: number }
  | { ok: false; formula: string; errors: string[]; attempts: number };

export function describeFields(fields: readonly AssistantFieldInfo[]): string {
  return fields.map((f) => `- ${f.name} (${f.resultType ?? f.type})`).join('\n');
}

export async function generateFormula(
  provider: AiProvider,
  request: FormulaRequest
): Promise<FormulaSuggestion> {
  const maxAttempts = Math.max(1, Math.min(3, request.maxAttempts ?? 2));
  const messages: AiMessage[] = [
    { role: 'system', content: formulaSystemPrompt() },
    {
      role: 'user',
      content: `Table fields:\n${describeFields(request.fields)}\n\nThe formula should: ${request.prompt}`,
    },
  ];
  let last: FormulaSuggestion = { ok: false, formula: '', errors: [], attempts: 0 };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { data, text } = await provider.chat({
      messages,
      output: { name: 'formula', schema: formulaAnswerSchema },
      maxTokens: 600,
      signal: request.signal,
    });
    const formula = data.formula.trim();
    const check = checkFormulaSuggestion(formula, request.fields);
    if (check.ok) {
      return {
        ok: true,
        formula,
        type: check.type,
        explanation: data.explanation,
        attempts: attempt,
      };
    }
    last = { ok: false, formula, errors: check.errors, attempts: attempt };
    messages.push(
      { role: 'assistant', content: text },
      {
        role: 'user',
        content: `That formula doesn't type-check: ${check.errors.join(' ')} Fix it and answer again.`,
      }
    );
  }
  return last;
}

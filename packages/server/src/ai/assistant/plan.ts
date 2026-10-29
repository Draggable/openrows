import {
  type AssistantBaseInfo,
  type AssistantPlanResult,
  assistantPlanOutputSchema,
  assistantPlanSchema,
  checkPlan,
} from '@openrows/shared';
import type { AiMessage, AiProvider } from '../provider.js';
import { AiProviderError } from '../provider.js';
import { describeBase, planSystemPrompt } from './prompt.js';

export type DescribedBase = AssistantBaseInfo & {
  tables: { name: string; fields: { name: string; type: string; detail?: string }[] }[];
};

export interface PlanRequest {
  base: DescribedBase;
  prompt: string;
  /** A new base ("Describe it"): `base` is empty. */
  newBase: boolean;
  /** Sample records by table name, only when the user opted in. */
  records?: string;
  signal?: AbortSignal;
}

/**
 * Asks the model for a change plan and checks it against the base. Formulas that don't
 * parse or type-check get one more round: the model sees the errors and answers the plan again.
 * Problems left after that are returned with the plan, for the user to see; nothing is applied.
 */
export async function generatePlan(
  provider: AiProvider,
  request: PlanRequest
): Promise<AssistantPlanResult> {
  const context = [
    request.newBase
      ? 'This is a new, empty base.'
      : `The base's schema:\n${describeBase(request.base)}`,
    request.records ? `\nA few records, as samples:\n${request.records}` : '',
    `\nThe request:\n${request.prompt}`,
  ].join('\n');
  const messages: AiMessage[] = [
    { role: 'system', content: planSystemPrompt(request.newBase) },
    { role: 'user', content: context },
  ];
  let attempts = 0;
  for (;;) {
    attempts++;
    const answer = await provider.chat({
      messages,
      output: { name: 'change_plan', schema: assistantPlanOutputSchema },
      maxTokens: 4096,
      signal: request.signal,
    });
    const capped = assistantPlanSchema.safeParse(answer.data);
    if (!capped.success) {
      throw new AiProviderError(
        'INVALID_OUTPUT',
        'The assistant proposed more than a plan can hold. Ask for less at once.',
        'plan caps'
      );
    }
    const plan = capped.data;
    if (request.newBase) plan.baseName ??= 'New base';
    else plan.baseName = null;
    const problems = checkPlan(plan, request.base);
    const formulas = problems.filter((p) => p.kind === 'formula');
    if (formulas.length === 0 || attempts >= 2) return { plan, problems, attempts };
    messages.push(
      { role: 'assistant', content: answer.text },
      {
        role: 'user',
        content: `These formulas don't type-check:\n${formulas
          .map((p) => `- ${p.message}`)
          .join('\n')}\nAnswer the whole plan again with the formulas fixed.`,
      }
    );
  }
}

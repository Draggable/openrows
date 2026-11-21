import {
  type AssistantBaseInfo,
  type AssistantPlan,
  type AssistantPlanResult,
  type AssistantProblem,
  assistantPlanOutputSchema,
  assistantPlanSchema,
  checkPlan,
  templateValuePaths,
} from '@openrows/shared';
import { SafeFetchError } from '../../lib/safe-fetch/index.js';
import type { AiMessage, AiProvider } from '../provider.js';
import { AiProviderError } from '../provider.js';
import { describeBase, planSystemPrompt } from './prompt.js';

export type DescribedBase = AssistantBaseInfo & {
  tables: {
    name: string;
    fields: { name: string; type: string; detail?: string }[];
    views?: { name: string; type: string }[];
  }[];
};

export interface PlanRequest {
  base: DescribedBase;
  prompt: string;
  /** A new base ("Describe it"): `base` is empty. */
  newBase: boolean;
  /** Sample records by table name, only when the user opted in. */
  records?: string;
  /** The automations' outbound URL check: HTTP steps' URLs it refuses are problems. */
  checkUrl: (url: string) => Promise<void>;
  signal?: AbortSignal;
}

function holdsTokens(text: string): boolean {
  try {
    return templateValuePaths(text).length > 0;
  } catch {
    // A malformed token: the automation service names it.
    return true;
  }
}

/**
 * The HTTP steps whose URL the automations' outbound rules refuse now, as the automation
 * service would (a URL with tokens is checked when a run fills them in). Automations are
 * the last thing a plan makes, so nothing else needs these operations.
 */
export async function urlProblems(
  plan: AssistantPlan,
  checkUrl: (url: string) => Promise<void>
): Promise<AssistantProblem[]> {
  const problems: AssistantProblem[] = [];
  for (const [i, op] of plan.operations.entries()) {
    if (op.op !== 'createAutomation') continue;
    for (const [j, a] of op.actions.entries()) {
      if (a.type !== 'httpRequest') continue;
      const url = a.url.trim();
      if (url === '' || holdsTokens(url)) continue;
      try {
        await checkUrl(url);
      } catch (err) {
        if (!(err instanceof SafeFetchError)) throw err;
        problems.push({
          operation: i,
          field: null,
          kind: 'reference',
          message: `Step ${j + 1}: this URL can't be used: ${err.message}.`,
        });
      }
    }
  }
  return problems;
}

/** What in a plan can't be applied: the checker's problems and refused URLs, in order. */
export async function planProblems(
  plan: AssistantPlan,
  base: AssistantBaseInfo,
  checkUrl: (url: string) => Promise<void>
): Promise<AssistantProblem[]> {
  const problems = [...checkPlan(plan, base), ...(await urlProblems(plan, checkUrl))];
  return problems.sort((a, b) => a.operation - b.operation);
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
    const problems = await planProblems(plan, request.base, request.checkUrl);
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

import {
  AI_PRESETS,
  type AiSettings,
  type UpdateAiSettings,
  usageResetDay,
} from '@openrows/shared';
import { ApiError } from '../../api/client';

/** The Settings → AI form: a preset or a custom OpenAI-compatible endpoint. */

export type PresetId = (typeof AI_PRESETS)[number]['id'] | 'custom';

export interface AiForm {
  preset: PresetId;
  baseUrl: string;
  model: string;
  /** Typed here only; empty keeps the stored key. */
  apiKey: string;
}

const trimSlash = (url: string) => url.trim().replace(/\/+$/, '');

export function presetFor(baseUrl: string): PresetId {
  return AI_PRESETS.find((p) => p.baseUrl === trimSlash(baseUrl))?.id ?? 'custom';
}

/** The form for the stored settings, or OpenAI's defaults without any. */
export function initialForm(settings: AiSettings | undefined): AiForm {
  const w = settings?.workspace;
  if (w) return { preset: presetFor(w.baseUrl), baseUrl: w.baseUrl, model: w.model, apiKey: '' };
  const first = AI_PRESETS[0];
  return { preset: first.id, baseUrl: first.baseUrl, model: first.model, apiKey: '' };
}

/** Picking a preset fills its URL and a default model; "custom" starts from an empty URL. */
export function choosePreset(form: AiForm, preset: PresetId): AiForm {
  if (preset === 'custom') {
    return { ...form, preset, baseUrl: form.preset === 'custom' ? form.baseUrl : '' };
  }
  const p = AI_PRESETS.find((x) => x.id === preset);
  if (!p) return form;
  return { ...form, preset, baseUrl: p.baseUrl, model: p.model };
}

/** Whether saving needs the key typed: none stored yet, or the stored one goes to a new URL. */
export function keyRequired(form: AiForm, settings: AiSettings | undefined): boolean {
  const w = settings?.workspace;
  return !w?.hasKey || trimSlash(w.baseUrl) !== trimSlash(form.baseUrl);
}

/** Why the form can't be saved yet, or null. */
export function formProblem(form: AiForm, settings: AiSettings | undefined): string | null {
  if (!/^https?:\/\/\S+$/i.test(form.baseUrl.trim())) return 'Enter the API base URL.';
  if (form.model.trim() === '') return 'Enter a model.';
  if (keyRequired(form, settings) && form.apiKey.trim() === '') return 'Enter an API key.';
  return null;
}

export function toRequest(form: AiForm): UpdateAiSettings {
  const key = form.apiKey.trim();
  return {
    baseUrl: trimSlash(form.baseUrl),
    model: form.model.trim(),
    ...(key ? { apiKey: key } : {}),
  };
}

/** What AI features use now, in a sentence. */
export function sourceText(settings: AiSettings): string {
  if (settings.source === 'workspace') {
    return "AI features use this workspace's own key.";
  }
  if (settings.source === 'instance') {
    const model = settings.instance.model ? ` (${settings.instance.model})` : '';
    const credits = settings.instance.credits;
    if (credits) {
      const n = (x: number) => x.toLocaleString('en-US');
      const left =
        credits.used >= credits.limit
          ? `This month's ${n(credits.limit)} AI credits are used up until ${usageResetDay(credits.resetsOn)}.`
          : `${n(credits.used)} of this month's ${n(credits.limit)} AI credits used.`;
      return `AI features use OpenRows' AI provider${model}. ${left} Add your own key to use another provider or model; its requests don't use credits.`;
    }
    return `AI features use this server's provider${model}. Add your own key to use another provider or model.`;
  }
  return 'AI is off: this server has no AI provider. Add an API key to turn AI features on in this workspace.';
}

/** The server's field messages for the form (422), and the overall message. */
export function saveErrors(err: unknown): { message: string; byField: Record<string, string> } {
  if (!(err instanceof ApiError)) return { message: "Couldn't save the AI settings.", byField: {} };
  const byField: Record<string, string> = {};
  const errors = (err.data as { errors?: { path?: unknown; message?: unknown }[] } | undefined)
    ?.errors;
  for (const e of errors ?? []) {
    if (typeof e.path === 'string' && typeof e.message === 'string' && !(e.path in byField)) {
      byField[e.path] = e.message;
    }
  }
  return { message: err.message || "Couldn't save the AI settings.", byField };
}

import { type ConditionContext, type ConditionField, matchesFilter } from './conditions.js';
import type { FormField } from './config.js';

export * from './conditions.js';
export * from './config.js';
export * from './public.js';

/**
 * The form fields that show for these answers, in order: a field shows when its
 * condition matches the answers above it, where a hidden field's answer counts as empty (so
 * hiding a field also hides the ones that depend on it).
 */
export function visibleFormFields(
  formFields: readonly FormField[],
  values: Readonly<Record<string, unknown>>,
  fields: readonly ConditionField[],
  context: ConditionContext = {}
): FormField[] {
  const seen: Record<string, unknown> = {};
  const out: FormField[] = [];
  for (const entry of formFields) {
    if (matchesFilter(entry.condition, seen, fields, context)) {
      out.push(entry);
      seen[entry.fieldId] = values[entry.fieldId];
    }
  }
  return out;
}

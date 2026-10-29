import { z } from 'zod';

/** Chip colours, in assignment order (docs/design/DESIGN.md "Select / chip palette"). */
export const CHOICE_COLORS = [
  'green',
  'amber',
  'blue',
  'red',
  'violet',
  'teal',
  'pink',
  'slate',
  'olive',
  'brown',
] as const;

export type ChoiceColor = (typeof CHOICE_COLORS)[number];

export const choiceColorSchema = z.enum(CHOICE_COLORS);

/** Colour for the n-th new choice (0-based), cycling through the palette. */
export function nextChoiceColor(index: number): ChoiceColor {
  return (
    CHOICE_COLORS[((index % CHOICE_COLORS.length) + CHOICE_COLORS.length) % CHOICE_COLORS.length] ??
    'green'
  );
}

/** Icons for rating and checkbox fields. */
export const FIELD_ICONS = ['check', 'star', 'heart', 'thumbsUp', 'flag', 'dot'] as const;
export const fieldIconSchema = z.enum(FIELD_ICONS);

/** Most choices a select field holds. */
export const MAX_CHOICES = 1000;

/** Longest choice name. */
export const MAX_CHOICE_NAME = 255;

/** Most choices one `typecast` write may create. */
export const MAX_TYPECAST_CHOICES = 100;

export const choiceSchema = z
  .object({
    /** Stable id stored in the column; renaming or recolouring a choice keeps it. */
    id: z.string().min(1).max(64),
    name: z.string().trim().min(1).max(MAX_CHOICE_NAME),
    color: choiceColorSchema,
  })
  .strict();

export type Choice = z.infer<typeof choiceSchema>;

export const selectOptionsSchema = z
  .object({ choices: z.array(choiceSchema).max(MAX_CHOICES).default([]) })
  .strict()
  .refine((o) => new Set(o.choices.map((c) => c.id)).size === o.choices.length, {
    message: 'Choice ids must be unique',
    path: ['choices'],
  });

export type SelectOptions = z.infer<typeof selectOptionsSchema>;

/** The choice id for an id, a name, or a case-insensitive name; `null` if none matches. */
export function matchChoice(text: string, choices: readonly Choice[]): string | null {
  const byId = choices.find((c) => c.id === text);
  if (byId) return byId.id;
  const t = text.trim();
  if (t === '') return null;
  const byName = choices.find((c) => c.name === t);
  if (byName) return byName.id;
  const lower = t.toLowerCase();
  return choices.find((c) => c.name.toLowerCase() === lower)?.id ?? null;
}

/** Position of a choice in the options, for `choiceOrder` sorting (unknown ids last). */
export function choiceIndex(id: string, choices: readonly Choice[]): number {
  const i = choices.findIndex((c) => c.id === id);
  return i === -1 ? choices.length : i;
}

export function choiceName(id: string, choices: readonly Choice[]): string {
  return choices.find((c) => c.id === id)?.name ?? '';
}

/** A new choice id: `sel` + 12 hex digits, the shape of every server- and client-made choice. */
export function newChoiceId(): string {
  return `sel${crypto.randomUUID().replaceAll('-', '').slice(-12)}`;
}

/**
 * The names among `texts` that match no choice (Airtable's `typecast` creates them): trimmed,
 * empty ones dropped, deduplicated case-insensitively, first occurrence first.
 */
export function unknownChoiceNames(texts: Iterable<string>, choices: readonly Choice[]): string[] {
  const known = new Set(choices.map((c) => c.name.toLowerCase()));
  const ids = new Set(choices.map((c) => c.id));
  const out: string[] = [];
  for (const text of texts) {
    const name = text.trim();
    const key = name.toLowerCase();
    if (name === '' || ids.has(text) || known.has(key)) continue;
    known.add(key);
    out.push(name);
  }
  return out;
}

/** Select options with `names` appended as new choices, in the palette's colour cycle. */
export function withNewChoices(options: SelectOptions, names: readonly string[]): SelectOptions {
  const n = options.choices.length;
  return {
    ...options,
    choices: [
      ...options.choices,
      ...names.map((name, i) => ({ id: newChoiceId(), name, color: nextChoiceColor(n + i) })),
    ],
  };
}

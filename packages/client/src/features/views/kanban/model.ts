import {
  type Choice,
  type Collaborator,
  type FieldMeta,
  type FilterCondition,
  isStackableField,
  type KanbanLayout,
} from '@openrows/shared';
import { choicesOf } from '../../grid/cells/model';

/**
 * The kanban board's logic, apart from React: the stacks of a stack field, which records a
 * stack holds (a `within` condition for the view query), the cell value a card dropped into it
 * gets, card sizes, and where a dropped or keyboard-moved card lands in the view's manual order.
 */

/** A leaf group of the board's count query: the stack field's value and its records. */
export type QueryGroup = { key: unknown[]; count: number };

/** One stack: a choice, a person, or the records with no value ("Uncategorized"). */
export interface Stack {
  /** The choice id or user id; `null` for the empty stack. */
  key: string | null;
  label: string;
  choice?: Choice;
  person?: Collaborator;
  /** The condition the stack's records meet (beside the view's filter). */
  within: FilterCondition;
  /** What the stack field becomes when a card is dropped here. */
  value: unknown;
}

/** Fields a view can stack by, in table order. */
export const stackableFields = (fields: readonly FieldMeta[]) =>
  fields.filter((f) => !f.deletedAt && isStackableField(f));

/**
 * The stacks of the stack field, empty one first (as in Airtable): every choice in order, or
 * every collaborator of the directory by name, then people the counts name that the directory
 * doesn't (former members).
 */
export function stacksOf(
  field: FieldMeta,
  people: readonly Collaborator[],
  groups: readonly QueryGroup[] = []
): Stack[] {
  const empty: Stack = {
    key: null,
    label: field.type === 'user' ? `No ${field.name.toLowerCase()}` : 'Uncategorized',
    within: { fieldId: field.id, operator: 'isEmpty' },
    value: null,
  };
  if (field.type === 'singleSelect') {
    return [
      empty,
      ...choicesOf(field).map((choice) => ({
        key: choice.id,
        label: choice.name,
        choice,
        within: { fieldId: field.id, operator: 'is' as const, value: choice.id },
        value: choice.id,
      })),
    ];
  }
  const ids = new Set(people.map((p) => p.id));
  const former = groups.flatMap((g) => {
    const id = stackKeyOf(field, g.key[0]);
    return id !== null && !ids.has(id) ? [id] : [];
  });
  const person = (id: string, p?: Collaborator): Stack => ({
    key: id,
    label: p?.name ?? 'Former member',
    ...(p ? { person: p } : {}),
    within: { fieldId: field.id, operator: 'hasAnyOf', value: [id] },
    value: [id],
  });
  return [
    empty,
    ...people.map((p) => person(p.id, p)),
    ...[...new Set(former)].map((id) => person(id)),
  ];
}

/** The stack a cell value belongs to: the choice id or the (first) user id, else `null`. */
export function stackKeyOf(field: FieldMeta, value: unknown): string | null {
  if (field.type === 'user') {
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === 'string' ? first : null;
  }
  if (typeof value !== 'string') return null;
  return choicesOf(field).some((c) => c.id === value) ? value : null;
}

/** Card counts per stack key from the board's group query (keys of empty groups merge). */
export function stackCounts(
  field: FieldMeta,
  groups: readonly QueryGroup[]
): Map<string | null, number> {
  const counts = new Map<string | null, number>();
  for (const g of groups) {
    const key = stackKeyOf(field, g.key[0]);
    counts.set(key, (counts.get(key) ?? 0) + g.count);
  }
  return counts;
}

/** The fields shown on cards: the saved ones that exist, else the first three after the title. */
export function cardFieldsOf(fields: readonly FieldMeta[], layout: KanbanLayout): FieldMeta[] {
  const live = fields.filter((f) => !f.deletedAt && !f.isPrimary);
  if (layout.cardFields) {
    return layout.cardFields.flatMap((id) => live.find((f) => f.id === id) ?? []);
  }
  return live.filter((f) => f.id !== layout.stackFieldId).slice(0, 3);
}

/** Card geometry (px): every card of a view has the same height, so stacks virtualize simply. */
export const CARD = { padding: 10, title: 20, row: 24, cover: 120, gap: 8 } as const;

export function cardHeight(fieldCount: number, cover: boolean): number {
  return CARD.padding * 2 + CARD.title + fieldCount * CARD.row + (cover ? CARD.cover + 8 : 0);
}

/** Where a card dragged over a stack would go: before the card under the pointer's half. */
export function dropIndex(offsetY: number, slot: number, count: number): number {
  return Math.max(0, Math.min(count, Math.round(offsetY / slot)));
}

/**
 * The rows a stack shows while a card is dragged or its move is saving: the stack's records
 * without `hidden` (the card leaving it), with a slot (placeholder or the moved card) before
 * record `insertAt`. Answers the row count and what each row is.
 */
export function stackRows(
  count: number,
  hidden: number | null,
  insertAt: number | null
): { count: number; at: (row: number) => { slot: true } | { slot: false; index: number } } {
  const shown = count - (hidden !== null && hidden < count ? 1 : 0);
  if (insertAt === null) {
    return {
      count: shown,
      at: (row) => ({ slot: false, index: hidden !== null && row >= hidden ? row + 1 : row }),
    };
  }
  // The slot's row: records before `insertAt`, minus the hidden one if it's among them.
  const slotRow = insertAt - (hidden !== null && hidden < insertAt ? 1 : 0);
  return {
    count: shown + 1,
    at: (row) => {
      if (row === slotRow) return { slot: true };
      const r = row > slotRow ? row - 1 : row;
      return { slot: false, index: hidden !== null && r >= hidden ? r + 1 : r };
    },
  };
}

/**
 * The card a record dropped before record `insertAt` of a stack goes after in the manual order:
 * the nearest record above that isn't the moving one, or `null` for the top.
 */
export function afterIdFor(
  idAt: (index: number) => string | undefined,
  insertAt: number,
  movingId: string
): string | null {
  for (let i = insertAt - 1; i >= 0; i--) {
    const id = idAt(i);
    if (id !== undefined && id !== movingId) return id;
  }
  return null;
}

/** A keyboard move (Alt+arrows): within the stack, or to the top of the next stack over. */
export type KeyboardMove =
  | { kind: 'reorder'; insertAt: number }
  | { kind: 'restack'; stack: number }
  | null;

export function keyboardMove(
  key: string,
  at: { stack: number; index: number },
  sizes: { stacks: number; count: number },
  canReorder: boolean
): KeyboardMove {
  switch (key) {
    case 'ArrowUp':
      return canReorder && at.index > 0 ? { kind: 'reorder', insertAt: at.index - 1 } : null;
    case 'ArrowDown':
      // Before the record after the next one.
      return canReorder && at.index < sizes.count - 1
        ? { kind: 'reorder', insertAt: at.index + 2 }
        : null;
    case 'ArrowLeft':
      return at.stack > 0 ? { kind: 'restack', stack: at.stack - 1 } : null;
    case 'ArrowRight':
      return at.stack < sizes.stacks - 1 ? { kind: 'restack', stack: at.stack + 1 } : null;
    default:
      return null;
  }
}

/** The first image of an attachment cell, for a card's cover. */
export function coverOf(value: unknown): { id: string; filename: string } | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as { id?: unknown }).id === 'string' &&
      String((item as { type?: unknown }).type ?? '').startsWith('image/')
    ) {
      const a = item as { id: string; filename?: unknown };
      return { id: a.id, filename: String(a.filename ?? '') };
    }
  }
  return null;
}

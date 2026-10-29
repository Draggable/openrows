import type {
  ChoiceColor,
  FieldMeta,
  RecordData,
  RowColor,
  RowColorCondition,
} from '@openrows/shared';
import { choicesOf } from '../../grid/cells/model';
import { activeConditionCount, newCondition } from '../toolbar/model';

/** The single select fields a view can colour its rows by. */
export function colorableFields(fields: readonly FieldMeta[]): FieldMeta[] {
  return fields.filter((f) => f.type === 'singleSelect' && !f.deletedAt);
}

/**
 * The colour conditions to send with the view's record queries: only in conditions mode,
 * and only those with at least one finished filter condition (an unfinished one would match
 * every record while it's being written).
 */
export function colorConditionsOf(rowColor: RowColor | null | undefined): RowColorCondition[] {
  if (rowColor?.mode !== 'conditions') return [];
  return rowColor.conditions.filter((c) => activeConditionCount(c.filter) > 0);
}

/**
 * A record's row colour: its choice's colour when colouring by a select field, else the colour
 * the server answered for its first matching condition (`colors`).
 */
export function rowColorOf(
  record: RecordData | undefined,
  rowColor: RowColor | null | undefined,
  fields: readonly FieldMeta[],
  colors: Readonly<Record<string, ChoiceColor>> | undefined
): ChoiceColor | undefined {
  if (!record || !rowColor) return undefined;
  if (rowColor.mode === 'conditions') return colors?.[record.id];
  const field = fields.find((f) => f.id === rowColor.fieldId);
  const value = field ? record.fields[field.id] : undefined;
  if (!field || typeof value !== 'string') return undefined;
  return choicesOf(field).find((c) => c.id === value)?.color;
}

/** A new colour condition: the next palette colour, one condition on the first field. */
export function newColorCondition(
  fields: readonly FieldMeta[],
  index: number,
  palette: readonly ChoiceColor[]
): RowColorCondition | null {
  const first = fields[0];
  if (!first) return null;
  return {
    color: palette[index % palette.length] ?? 'green',
    filter: { conjunction: 'and', conditions: [newCondition(first)] },
  };
}

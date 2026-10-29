import { z } from 'zod';
import { TEXT_OPERATORS } from '../text-like.js';
import { compareNullable, compareText, defineFieldType, first } from '../util.js';

/** Longest source key: a record id, or a key field's text. */
export const MAX_SYNC_KEY_LENGTH = 1000;

function readKey(input: unknown): string | null {
  const v = first(input);
  const text =
    typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
  if (text === null) return null;
  const key = text.trim();
  return key === '' || key.length > MAX_SYNC_KEY_LENGTH ? null : key;
}

/**
 * Where a synced record comes from: the source record's key (its id, or the sync's key
 * field's text) in a table synced from another base or view. Only the sync engine writes it
 * (packages/server/src/syncs/), never a person; it is how a run matches source records to the
 * table's records, so re-running a sync updates them in place. `generated`: snapshots, restores
 * and duplicates copy its values.
 */
export const syncSource = defineFieldType({
  name: 'syncSource',
  label: 'Sync source',
  category: 'computed',
  optionsSchema: z.object({}).strict(),
  storage: { kind: 'computed', sqlType: 'text', generated: true },
  filterOperators: TEXT_OPERATORS,
  sort: 'text',
  formulaType: 'text',
  editor: { kind: 'none', align: 'left', width: 200 },
  readOnly: true,
  computed: true,
  conversionInput: 'primitive',
  emptyValue: null,
  valueSchema: () => z.string().min(1).max(MAX_SYNC_KEY_LENGTH),
  coerce: readKey,
  toStorage: (value) => value,
  fromStorage: readKey,
  compare: (a, b) => compareNullable(a, b, compareText),
  format: (value) => value ?? '',
  toPrimitive: (value) => value,
});

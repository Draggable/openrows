import { dateTimeLike } from '../date-like.js';

/** When the record was created: the record table's `created_at` system column. */
export const createdTime = dateTimeLike({
  name: 'createdTime',
  label: 'Created time',
  category: 'computed',
  storage: { kind: 'system', column: 'created_at', sqlType: 'timestamptz' },
  editor: { kind: 'none', align: 'left', width: 180 },
  readOnly: true,
  computed: true,
});

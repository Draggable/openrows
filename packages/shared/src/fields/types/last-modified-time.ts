import { dateTimeLike } from '../date-like.js';

/** When any field of the record last changed: the `updated_at` system column. */
export const lastModifiedTime = dateTimeLike({
  name: 'lastModifiedTime',
  label: 'Last modified time',
  category: 'computed',
  storage: { kind: 'system', column: 'updated_at', sqlType: 'timestamptz' },
  editor: { kind: 'none', align: 'left', width: 180 },
  readOnly: true,
  computed: true,
});

import { dateTimeLike } from '../date-like.js';

/**
 * A point in time, stored as `timestamptz` and returned as a UTC ISO string. `timeZone` (IANA,
 * default UTC) is the zone it's shown in and the zone input without an offset is read in.
 */
export const dateTime = dateTimeLike({
  name: 'dateTime',
  label: 'Date and time',
  category: 'basic',
  storage: { kind: 'column', sqlType: 'timestamptz' },
  editor: { kind: 'dateTime', align: 'left', width: 180 },
  readOnly: false,
  computed: false,
});

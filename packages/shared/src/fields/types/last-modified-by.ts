import { userLike } from '../user-like.js';

/** Who last changed the record: the `updated_by` system column. */
export const lastModifiedBy = userLike({
  name: 'lastModifiedBy',
  label: 'Last modified by',
  column: 'updated_by',
});

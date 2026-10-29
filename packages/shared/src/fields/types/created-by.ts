import { userLike } from '../user-like.js';

/** Who created the record: the `created_by` system column. */
export const createdBy = userLike({ name: 'createdBy', label: 'Created by', column: 'created_by' });

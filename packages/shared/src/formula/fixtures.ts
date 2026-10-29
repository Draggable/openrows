import type { FormulaFieldInfo } from './check.js';

// Fields the golden and fuzz tests reference (not part of the package's API). Ids are UUIDv7
// shaped and numbered so stored forms stay readable.
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

export const FIXTURE_FIELDS: readonly FormulaFieldInfo[] = [
  { id: id(1), name: 'Name', type: 'singleLineText' },
  { id: id(2), name: 'Notes', type: 'longText' },
  { id: id(3), name: 'Price', type: 'number' },
  { id: id(4), name: 'Qty', type: 'number' },
  { id: id(5), name: 'Unit Price', type: 'currency' },
  { id: id(6), name: 'Discount', type: 'percent' },
  { id: id(7), name: 'Done', type: 'checkbox' },
  { id: id(8), name: 'Due', type: 'date' },
  { id: id(9), name: 'Start', type: 'dateTime' },
  { id: id(10), name: 'Duration', type: 'duration' },
  { id: id(11), name: 'Rating', type: 'rating' },
  { id: id(12), name: 'Status', type: 'singleSelect' },
  { id: id(13), name: 'Tags', type: 'multipleSelect' },
  { id: id(14), name: 'Email', type: 'email' },
  { id: id(15), name: 'Website', type: 'url' },
  { id: id(16), name: 'Phone', type: 'phone' },
  { id: id(17), name: 'Files', type: 'attachment' },
  { id: id(18), name: 'ID', type: 'autoNumber' },
  { id: id(19), name: 'Created', type: 'createdTime' },
  { id: id(20), name: 'Modified', type: 'lastModifiedTime' },
  { id: id(21), name: 'Created By', type: 'createdBy' },
  { id: id(22), name: 'Modified By', type: 'lastModifiedBy' },
  { id: id(23), name: 'Weird } name', type: 'singleLineText' },
  { id: id(24), name: 'Back\\slash', type: 'number' },
  { id: id(25), name: 'Ünïcödé', type: 'singleLineText' },
  { id: id(26), name: 'Total (USD)', type: 'currency' },
  { id: id(27), name: 'Score', type: 'formula', resultType: 'number' },
  { id: id(28), name: 'Label', type: 'formula', resultType: 'text' },
  { id: id(29), name: 'Lookup Prices', type: 'lookup', resultType: 'array' },
  { id: id(30), name: 'Mystery', type: 'notAType' },
  { id: id(31), name: 'Case', type: 'singleLineText' },
  { id: id(32), name: 'case', type: 'number' },
];

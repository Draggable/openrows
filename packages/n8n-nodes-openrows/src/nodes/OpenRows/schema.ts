import type {
  FieldType,
  IDataObject,
  INodePropertyOptions,
  ResourceMapperField,
} from 'n8n-workflow';
import { type ApiContext, apiRequest, seg } from './transport';

/** A field as `GET /api/v1/meta/bases/:baseId/tables` answers it. */
export interface ApiField {
  id: string;
  name: string;
  type: string;
  openrowsType: string;
  description?: string;
  options?: unknown;
}

export interface ApiTable {
  id: string;
  name: string;
  primaryFieldId: string;
  fields: ApiField[];
  views: { id: string; name: string; type: string }[];
}

export interface ApiBase {
  id: string;
  name: string;
  permissionLevel: string;
}

/**
 * OpenRows' field types whose values are computed (the registry's `readOnly`, checked by
 * schema.test.ts): left out of what the nodes write.
 */
export const READ_ONLY_TYPES = new Set([
  'ai',
  'autoNumber',
  'button',
  'count',
  'createdBy',
  'createdTime',
  'formula',
  'lastModifiedBy',
  'lastModifiedTime',
  'lookup',
  'rollup',
  'syncSource',
]);

/** Field types `search` looks in when no fields are picked. */
export const SEARCHABLE_TYPES = new Set([
  'singleLineText',
  'longText',
  'email',
  'url',
  'phone',
  'barcode',
]);

/** Field types an upsert can match on (one plain value to compare). */
const MATCHABLE_TYPES = new Set([
  'singleLineText',
  'email',
  'url',
  'phone',
  'barcode',
  'number',
  'currency',
  'percent',
  'rating',
  'duration',
  'date',
  'dateTime',
  'singleSelect',
  'checkbox',
]);

/** n8n's type for a field's values in the column mapper. */
export function mapperType(openrowsType: string): FieldType {
  switch (openrowsType) {
    case 'number':
    case 'currency':
    case 'percent':
    case 'rating':
    case 'duration':
      return 'number';
    case 'checkbox':
      return 'boolean';
    case 'date':
    case 'dateTime':
      return 'dateTime';
    case 'singleSelect':
      return 'options';
    case 'multipleSelect':
    case 'link':
    case 'attachment':
    case 'user':
      return 'array';
    case 'url':
      return 'url';
    default:
      return 'string';
  }
}

/** A select field's choice names, from its options. */
export function choiceNames(options: unknown): string[] {
  if (!options || typeof options !== 'object' || !('choices' in options)) return [];
  const choices = (options as { choices: unknown }).choices;
  if (!Array.isArray(choices)) return [];
  return choices
    .map((c) => (c && typeof c === 'object' ? (c as IDataObject)['name'] : undefined))
    .filter((n): n is string => typeof n === 'string');
}

/** The column mapper's fields for a table: every writable field, by name. */
export function mapperFields(table: ApiTable, mode: 'add' | 'upsert'): ResourceMapperField[] {
  return table.fields
    .filter((f) => !READ_ONLY_TYPES.has(f.openrowsType))
    .map((f) => {
      const type = mapperType(f.openrowsType);
      const field: ResourceMapperField = {
        id: f.name,
        displayName: f.name,
        required: false,
        defaultMatch: false,
        display: true,
        type,
        canBeUsedToMatch: mode === 'upsert' && MATCHABLE_TYPES.has(f.openrowsType),
      };
      if (type === 'options') {
        field.options = choiceNames(f.options).map((name) => ({ name, value: name }));
      }
      return field;
    });
}

export async function listBases(ctx: ApiContext): Promise<ApiBase[]> {
  const res = await apiRequest<{ bases: ApiBase[] }>(ctx, 'GET', '/meta/bases');
  return res.bases;
}

export async function listTables(ctx: ApiContext, baseId: string): Promise<ApiTable[]> {
  const res = await apiRequest<{ tables: ApiTable[] }>(
    ctx,
    'GET',
    `/meta/bases/${seg(baseId)}/tables`
  );
  return res.tables;
}

/** A table of the base by id or exact name (as the API reads it), or undefined. */
export async function findTable(
  ctx: ApiContext,
  baseId: string,
  table: string
): Promise<ApiTable | undefined> {
  const tables = await listTables(ctx, baseId);
  return tables.find((t) => t.id === table) ?? tables.find((t) => t.name === table);
}

/** Options sorted by name, filtered by `filter` (case-insensitive). */
export function filterOptions<T extends { id: string; name: string }>(
  items: readonly T[],
  filter?: string
): INodePropertyOptions[] {
  const needle = filter?.trim().toLowerCase();
  return items
    .filter((i) => !needle || i.name.toLowerCase().includes(needle))
    .map((i) => ({ name: i.name, value: i.id }));
}

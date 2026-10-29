import type {
  ILoadOptionsFunctions,
  INodeListSearchResult,
  INodePropertyOptions,
  ResourceMapperFields,
} from 'n8n-workflow';
import {
  type ApiTable,
  filterOptions,
  findTable,
  listBases,
  listTables,
  mapperFields,
  SEARCHABLE_TYPES,
} from './schema';

/** A resource locator's value (`extractValue`), '' when unset. */
function locatorValue(ctx: ILoadOptionsFunctions, name: string): string {
  try {
    const value = ctx.getNodeParameter(name, undefined, { extractValue: true });
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

/** The picked table's schema, or undefined while no base or table is picked. */
async function pickedTable(ctx: ILoadOptionsFunctions): Promise<ApiTable | undefined> {
  const baseId = locatorValue(ctx, 'base');
  const table = locatorValue(ctx, 'table');
  if (!baseId || !table) return undefined;
  return findTable(ctx, baseId, table);
}

const byName = (a: INodePropertyOptions, b: INodePropertyOptions) => a.name.localeCompare(b.name);

export const listSearch = {
  async searchBases(this: ILoadOptionsFunctions, filter?: string): Promise<INodeListSearchResult> {
    const bases = await listBases(this);
    return { results: filterOptions(bases, filter).sort(byName) };
  },

  async searchTables(this: ILoadOptionsFunctions, filter?: string): Promise<INodeListSearchResult> {
    const baseId = locatorValue(this, 'base');
    if (!baseId) return { results: [] };
    return { results: filterOptions(await listTables(this, baseId), filter) };
  },
};

export const loadOptions = {
  /** Every field of the picked table, by name (what the API reads in `fields` and `sort`). */
  async getFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
    const table = await pickedTable(this);
    return (table?.fields ?? []).map((f) => ({ name: f.name, value: f.name }));
  },

  /** The picked table's text fields, which `search` looks in. */
  async getSearchFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
    const table = await pickedTable(this);
    return (table?.fields ?? [])
      .filter((f) => SEARCHABLE_TYPES.has(f.openrowsType))
      .map((f) => ({ name: f.name, value: f.name }));
  },

  async getViews(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
    const table = await pickedTable(this);
    return (table?.views ?? []).map((v) => ({ name: v.name, value: v.id }));
  },

  /** The picked base's tables, by id (the trigger's table filter). */
  async getTables(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
    const baseId = locatorValue(this, 'base');
    if (!baseId) return [];
    return filterOptions(await listTables(this, baseId));
  },
};

async function columns(ctx: ILoadOptionsFunctions, mode: 'add' | 'upsert') {
  const table = await pickedTable(ctx);
  const fields: ResourceMapperFields = { fields: table ? mapperFields(table, mode) : [] };
  if (!table) fields.emptyFieldsNotice = 'Pick a base and a table first';
  return fields;
}

export const resourceMapping = {
  async getColumns(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
    return columns(this, 'add');
  },

  async getColumnsWithMatch(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
    return columns(this, 'upsert');
  },
};

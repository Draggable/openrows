import {
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  NodeOperationError,
  type ResourceMapperField,
} from 'n8n-workflow';
import { findTable, SEARCHABLE_TYPES } from './schema';
import { apiRequest, BATCH_SIZE, PAGE_SIZE, recordsQuery, seg } from './transport';

/** A record as the API answers it. */
interface ApiRecord {
  id: string;
  createdTime: string;
  fields: IDataObject;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Fields `search` looks in at most when none are picked. */
const MAX_SEARCH_FIELDS = 20;
const MAX_SEARCH_LENGTH = 200;

/** A record as one n8n item: its cells by field name, then `id` and `createdTime`. */
export function recordJson(record: ApiRecord): IDataObject {
  return { ...record.fields, id: record.id, createdTime: record.createdTime };
}

/** A formula text literal. */
export function formulaString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/** A formula field reference, `{Name}`. */
export function formulaField(name: string): string {
  return `{${name.replace(/[\\}]/g, (c) => `\\${c}`)}}`;
}

/** `filterByFormula` finding `text` in any of `fields`, and in `filter` when given. */
export function searchFormula(text: string, fields: readonly string[], filter?: string): string {
  const terms = fields.map((f) => `SEARCH(${formulaString(text)}, ${formulaField(f)})`);
  const found = terms.length === 1 ? (terms[0] ?? '') : `OR(${terms.join(', ')})`;
  return filter ? `AND(${filter}, ${found})` : found;
}

interface Target {
  baseId: string;
  table: string;
}

function target(ctx: IExecuteFunctions, i: number): Target {
  const baseId = String(ctx.getNodeParameter('base', i, '', { extractValue: true })).trim();
  const table = String(ctx.getNodeParameter('table', i, '', { extractValue: true })).trim();
  if (!UUID.test(baseId)) {
    throw new NodeOperationError(ctx.getNode(), 'Pick a base (or enter its ID)', { itemIndex: i });
  }
  if (!table) throw new NodeOperationError(ctx.getNode(), 'Pick a table', { itemIndex: i });
  return { baseId, table };
}

function recordId(ctx: IExecuteFunctions, i: number): string {
  const id = String(ctx.getNodeParameter('recordId', i, '')).trim();
  if (!UUID.test(id)) {
    throw new NodeOperationError(ctx.getNode(), `"${id.slice(0, 64)}" is not a record ID`, {
      itemIndex: i,
    });
  }
  return id;
}

const tablePath = (t: Target) => `/${seg(t.baseId)}/${seg(t.table)}`;

/**
 * An item's cells from the column mapper: the values set below, or the item's own JSON narrowed
 * to the table's writable fields (auto-map), so `id`, `createdTime` and computed fields an
 * earlier OpenRows node returned aren't sent back.
 */
function cells(ctx: IExecuteFunctions, i: number, item: INodeExecutionData): IDataObject {
  const mode = ctx.getNodeParameter('columns.mappingMode', i) as string;
  if (mode === 'autoMapInputData') {
    const schema = ctx.getNodeParameter('columns.schema', i, []) as ResourceMapperField[];
    const writable = new Set(schema.filter((f) => !f.removed && !f.readOnly).map((f) => f.id));
    return Object.fromEntries(Object.entries(item.json).filter(([key]) => writable.has(key)));
  }
  const values = (ctx.getNodeParameter('columns.value', i, {}) ?? {}) as IDataObject;
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
}

/** One write request's worth of items. */
interface Batch<T> {
  key: string;
  target: Target;
  typecast: boolean;
  items: { index: number; value: T }[];
}

/**
 * Groups consecutive items that go to the same table with the same options into batches of
 * `BATCH_SIZE` (the API's limit), so 100 items are 10 requests, in order.
 */
function batches<T>(
  ctx: IExecuteFunctions,
  items: INodeExecutionData[],
  read: (i: number, item: INodeExecutionData) => { value: T; key?: string },
  onError: (i: number, error: Error) => void
): Batch<T>[] {
  const out: Batch<T>[] = [];
  items.forEach((item, i) => {
    try {
      const t = target(ctx, i);
      const typecast = Boolean(ctx.getNodeParameter('options.typecast', i, false));
      const { value, key: extra = '' } = read(i, item);
      const key = JSON.stringify([t.baseId, t.table, typecast, extra]);
      const last = out.at(-1);
      if (last && last.key === key && last.items.length < BATCH_SIZE) {
        last.items.push({ index: i, value });
      } else {
        out.push({ key, target: t, typecast, items: [{ index: i, value }] });
      }
    } catch (error) {
      onError(i, error as Error);
    }
  });
  return out;
}

type Runner = (
  ctx: IExecuteFunctions,
  items: INodeExecutionData[]
) => Promise<INodeExecutionData[]>;

/** Runs write batches; a failed batch fails each of its items (or the node). */
function writer<T>(
  read: (ctx: IExecuteFunctions, i: number, item: INodeExecutionData) => { value: T; key?: string },
  send: (ctx: IExecuteFunctions, batch: Batch<T>) => Promise<IDataObject[]>
): Runner {
  return async (ctx, items) => {
    const results: (INodeExecutionData | undefined)[] = new Array(items.length);
    const fail = (i: number, error: Error) => {
      if (!ctx.continueOnFail()) throw error;
      results[i] = { json: { error: error.message }, pairedItem: { item: i } };
    };
    for (const batch of batches(ctx, items, (i, item) => read(ctx, i, item), fail)) {
      try {
        const out = await send(ctx, batch);
        batch.items.forEach(({ index }, n) => {
          results[index] = { json: out[n] ?? {}, pairedItem: { item: index } };
        });
      } catch (error) {
        for (const { index } of batch.items) fail(index, error as Error);
      }
    }
    return results.filter((r): r is INodeExecutionData => r !== undefined);
  };
}

const create = writer<IDataObject>(
  (ctx, i, item) => ({ value: cells(ctx, i, item) }),
  async (ctx, batch) => {
    const res = await apiRequest<{ records: ApiRecord[] }>(ctx, 'POST', tablePath(batch.target), {
      body: { records: batch.items.map((r) => ({ fields: r.value })), typecast: batch.typecast },
      itemIndex: batch.items[0]?.index,
    });
    return res.records.map(recordJson);
  }
);

const update = writer<{ id: string; fields: IDataObject }>(
  (ctx, i, item) => ({ value: { id: recordId(ctx, i), fields: cells(ctx, i, item) } }),
  async (ctx, batch) => {
    const res = await apiRequest<{ records: ApiRecord[] }>(ctx, 'PATCH', tablePath(batch.target), {
      body: { records: batch.items.map((r) => r.value), typecast: batch.typecast },
      itemIndex: batch.items[0]?.index,
    });
    return res.records.map(recordJson);
  }
);

const upsert = writer<{ fields: IDataObject; mergeOn: string[] }>(
  (ctx, i, item) => {
    const mergeOn = (ctx.getNodeParameter('columns.matchingColumns', i, []) as string[]) ?? [];
    if (mergeOn.length < 1 || mergeOn.length > 3) {
      throw new NodeOperationError(ctx.getNode(), 'Pick 1 to 3 fields to match on', {
        itemIndex: i,
      });
    }
    const fields = cells(ctx, i, item);
    const missing = mergeOn.filter((f) => !(f in fields));
    if (missing.length) {
      throw new NodeOperationError(ctx.getNode(), `No value for "${missing.join('", "')}"`, {
        description: 'Fields to match on need a value in the item',
        itemIndex: i,
      });
    }
    return { value: { fields, mergeOn }, key: JSON.stringify(mergeOn) };
  },
  async (ctx, batch) => {
    const fieldsToMergeOn = batch.items[0]?.value.mergeOn ?? [];
    const res = await apiRequest<{ records: ApiRecord[] }>(ctx, 'PATCH', tablePath(batch.target), {
      body: {
        records: batch.items.map((r) => ({ fields: r.value.fields })),
        performUpsert: { fieldsToMergeOn },
        typecast: batch.typecast,
      },
      itemIndex: batch.items[0]?.index,
    });
    return res.records.map(recordJson);
  }
);

const remove = writer<string>(
  (ctx, i) => ({ value: recordId(ctx, i) }),
  async (ctx, batch) => {
    const res = await apiRequest<{ records: { id: string; deleted: boolean }[] }>(
      ctx,
      'DELETE',
      tablePath(batch.target),
      { query: recordsQuery(batch.items.map((r) => r.value)), itemIndex: batch.items[0]?.index }
    );
    return res.records.map((r) => ({ id: r.id, deleted: r.deleted }));
  }
);

/** Runs `run` per item, its results paired with it. */
function perItem(run: (ctx: IExecuteFunctions, i: number) => Promise<IDataObject[]>): Runner {
  return async (ctx, items) => {
    const out: INodeExecutionData[] = [];
    for (let i = 0; i < items.length; i++) {
      try {
        for (const json of await run(ctx, i)) out.push({ json, pairedItem: { item: i } });
      } catch (error) {
        if (!ctx.continueOnFail()) throw error;
        out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
      }
    }
    return out;
  };
}

const get = perItem(async (ctx, i) => {
  const t = target(ctx, i);
  const id = recordId(ctx, i);
  const record = await apiRequest<ApiRecord>(ctx, 'GET', `${tablePath(t)}/${seg(id)}`, {
    itemIndex: i,
  });
  return [recordJson(record)];
});

interface ListOptions {
  filterByFormula?: string;
  fields?: string[];
  sort?: { rule?: { field: string; direction?: 'asc' | 'desc' }[] };
  view?: string;
}

/** Pages through `POST …/listRecords` until `limit` records (or all). */
async function list(
  ctx: IExecuteFunctions,
  i: number,
  t: Target,
  filterByFormula: string | undefined
): Promise<IDataObject[]> {
  const returnAll = ctx.getNodeParameter('returnAll', i, false) as boolean;
  const limit = returnAll
    ? Number.POSITIVE_INFINITY
    : (ctx.getNodeParameter('limit', i, 50) as number);
  const options = ctx.getNodeParameter('options', i, {}) as ListOptions;
  const body: IDataObject = {};
  if (filterByFormula) body['filterByFormula'] = filterByFormula;
  if (options.fields?.length) body['fields'] = options.fields;
  const sort = (options.sort?.rule ?? []).filter((r) => r.field);
  if (sort.length)
    body['sort'] = sort.map((r) => ({ field: r.field, direction: r.direction ?? 'asc' }));
  if (options.view) body['view'] = options.view;
  const out: IDataObject[] = [];
  let offset: string | undefined;
  do {
    const pageSize = Math.min(PAGE_SIZE, limit - out.length);
    const page = await apiRequest<{ records: ApiRecord[]; offset?: string }>(
      ctx,
      'POST',
      `${tablePath(t)}/listRecords`,
      { body: { ...body, pageSize, ...(offset ? { offset } : {}) }, itemIndex: i }
    );
    out.push(...page.records.slice(0, limit - out.length).map(recordJson));
    offset = page.offset;
  } while (offset && out.length < limit);
  return out;
}

const getAll = perItem(async (ctx, i) => {
  const options = ctx.getNodeParameter('options', i, {}) as ListOptions;
  return list(ctx, i, target(ctx, i), options.filterByFormula?.trim() || undefined);
});

const search = perItem(async (ctx, i) => {
  const t = target(ctx, i);
  const text = String(ctx.getNodeParameter('searchText', i, ''));
  if (!text.trim()) {
    throw new NodeOperationError(ctx.getNode(), 'Enter some text to search for', { itemIndex: i });
  }
  if (text.length > MAX_SEARCH_LENGTH) {
    throw new NodeOperationError(
      ctx.getNode(),
      `Search text is limited to ${MAX_SEARCH_LENGTH} characters`,
      { itemIndex: i }
    );
  }
  let fields = (ctx.getNodeParameter('searchFields', i, []) as string[]).filter(Boolean);
  if (!fields.length) {
    const table = await findTable(ctx, t.baseId, t.table);
    if (!table) {
      throw new NodeOperationError(ctx.getNode(), `No table "${t.table}" in this base`, {
        itemIndex: i,
      });
    }
    fields = table.fields
      .filter((f) => SEARCHABLE_TYPES.has(f.openrowsType))
      .slice(0, MAX_SEARCH_FIELDS)
      .map((f) => f.name);
    if (!fields.length) {
      throw new NodeOperationError(ctx.getNode(), 'This table has no text fields to search', {
        itemIndex: i,
      });
    }
  }
  const options = ctx.getNodeParameter('options', i, {}) as ListOptions;
  return list(ctx, i, t, searchFormula(text, fields, options.filterByFormula?.trim() || undefined));
});

export const OPERATIONS: Record<string, Runner> = {
  create,
  delete: remove,
  get,
  getAll,
  search,
  update,
  upsert,
};

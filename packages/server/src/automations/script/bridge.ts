import {
  FILTER_OPERATORS,
  MAX_FILTER_CONDITIONS,
  MAX_SORTS,
  QUERY_PAGE_MAX,
  queryRecordsSchema,
  roleAllows,
  type UserRole,
} from '@openrows/shared';
import { z } from 'zod';
import type { Transaction } from '../../db/index.js';
import type { Entitlements } from '../../edition/types.js';
import type { TableRow } from '../../fields/service.js';
import { type SafeFetch, SafeFetchError } from '../../lib/safe-fetch/index.js';
import { OutboundDeferred } from '../../outbound/limits.js';
import {
  createRecords,
  deleteRecords,
  type FieldInfo,
  getRecord,
  queryRecords,
  tableFields,
  updateRecords,
} from '../../records/service.js';
import { baseTable } from '../service.js';
import { type ScriptBridge, ScriptCallError, type ScriptMethod } from './types.js';

/**
 * A script's calls, run by the server in the run's transaction as the person the run runs
 * as, with their live role: the RecordService checks table and field edit permissions on every
 * write, and tables are looked up in the automation's base only (another base's table id is
 * "no such table"). Each call has its own savepoint, so a refused write is rolled back alone and
 * the script may catch the error. `fetch` goes through the SSRF-safe client.
 */

/** Records one create, update or delete call takes. */
export const MAX_SCRIPT_WRITE = 50;
/** `fetch` calls in one script. */
export const MAX_SCRIPT_FETCHES = 20;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_FETCH_BYTES = 1024 * 1024;

export interface ScriptBridgeEnv {
  tx: Transaction;
  /** The run's automation: its writes' revisions say `via: 'automation'`. */
  automationId: string;
  workspaceId: string;
  baseId: string;
  userId: string;
  role: UserRole;
  /** The workspace's plan: creates past records per base are refused. */
  entitlements: Entitlements;
  /** The SSRF-safe client; undefined: `fetch` fails as not configured. */
  http: SafeFetch | undefined;
  /** A message for an error the script should see (a refused write, a bad filter), else null. */
  describe: (err: unknown) => string | null;
}

const key = z.string().min(1).max(255);
const cells = z.record(z.string().max(255), z.unknown());

const conditionSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.strictObject({
      field: key.optional(),
      fieldId: key.optional(),
      operator: z.enum(FILTER_OPERATORS),
      value: z.unknown().optional(),
    }),
    filterSchema,
  ])
);
const filterSchema = z.strictObject({
  conjunction: z.enum(['and', 'or']).default('and'),
  conditions: z.array(conditionSchema).max(MAX_FILTER_CONDITIONS),
});

const argsSchemas = {
  select: z.strictObject({
    tableId: z.uuid(),
    filter: filterSchema.optional(),
    sorts: z
      .array(z.strictObject({ field: key, direction: z.enum(['asc', 'desc']).default('asc') }))
      .max(MAX_SORTS)
      .optional(),
    fields: z.array(key).max(500).optional(),
    maxRecords: z.number().int().min(1).max(QUERY_PAGE_MAX).default(QUERY_PAGE_MAX),
  }),
  get: z.strictObject({ tableId: z.uuid(), recordId: z.uuid() }),
  create: z.strictObject({
    tableId: z.uuid(),
    records: z
      .array(z.strictObject({ fields: cells }))
      .min(1)
      .max(MAX_SCRIPT_WRITE),
  }),
  update: z.strictObject({
    tableId: z.uuid(),
    records: z
      .array(z.strictObject({ id: z.uuid(), fields: cells }))
      .min(1)
      .max(MAX_SCRIPT_WRITE),
  }),
  delete: z.strictObject({
    tableId: z.uuid(),
    recordIds: z.array(z.uuid()).min(1).max(MAX_SCRIPT_WRITE),
  }),
  fetch: z.strictObject({
    url: z.string().min(1).max(2000),
    method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    headers: z
      .record(z.string().max(100), z.string().max(4000))
      .refine((h) => Object.keys(h).length <= 30, { message: 'At most 30 headers.' })
      .default({}),
    body: z.string().max(MAX_FETCH_BYTES).nullable().default(null),
  }),
} satisfies Record<ScriptMethod, z.ZodType>;

type Loaded = { table: TableRow; fields: FieldInfo[] };

/** A record as scripts see it: cells by field name. */
function scriptRecord(
  record: { id: string; createdAt: string; updatedAt: string; fields: Record<string, unknown> },
  fields: readonly FieldInfo[]
) {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.row.id in record.fields) out[f.row.name] = record.fields[f.row.id] ?? null;
  }
  return { id: record.id, createdAt: record.createdAt, updatedAt: record.updatedAt, fields: out };
}

function fail(message: string): never {
  throw new ScriptCallError(message);
}

export function createScriptBridge(env: ScriptBridgeEnv): ScriptBridge {
  let fetches = 0;

  const load = async (tx: Transaction, tableId: string): Promise<Loaded> => {
    const table = await baseTable(tx, env.baseId, tableId);
    if (!table) fail('No such table in this base.');
    return { table, fields: await tableFields(tx, table) };
  };
  const fieldId = (t: Loaded, nameOrId: string): string => {
    const f =
      t.fields.find((x) => x.row.id === nameOrId) ?? t.fields.find((x) => x.row.name === nameOrId);
    if (!f) fail(`No field "${nameOrId.slice(0, 100)}" in ${t.table.name}.`);
    return f.row.id;
  };
  const byId = (t: Loaded, input: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(input).map(([k, v]) => [fieldId(t, k), v]));
  const filterById = (t: Loaded, filter: unknown): unknown => {
    const group = filter as { conjunction: string; conditions: Record<string, unknown>[] };
    return {
      conjunction: group.conjunction,
      conditions: group.conditions.map((c) => {
        if ('conditions' in c) return filterById(t, c);
        const { field, fieldId: id, ...rest } = c;
        const name = (field ?? id) as string | undefined;
        if (!name) fail('A filter condition needs a field.');
        return { fieldId: fieldId(t, name), ...rest };
      }),
    };
  };
  const mayWrite = (action: 'record:create' | 'record:update' | 'record:delete') => {
    if (!roleAllows(env.role, action)) {
      fail(`The person this automation runs as can't ${action.slice(7)} records.`);
    }
  };

  const methods: {
    [M in ScriptMethod]: (
      tx: Transaction,
      args: z.infer<(typeof argsSchemas)[M]>
    ) => Promise<unknown>;
  } = {
    select: async (tx, a) => {
      const t = await load(tx, a.tableId);
      const query = queryRecordsSchema.parse({
        query: {
          ...(a.filter ? { filter: filterById(t, a.filter) } : {}),
          ...(a.sorts
            ? {
                sorts: a.sorts.map((s) => ({
                  fieldId: fieldId(t, s.field),
                  direction: s.direction,
                })),
              }
            : {}),
          ...(a.fields ? { fields: a.fields.map((f) => fieldId(t, f)) } : {}),
        },
        limit: a.maxRecords,
        count: false,
      });
      const ctx = { tx, workspaceId: env.workspaceId, userId: env.userId, table: t.table };
      const page = await queryRecords(ctx, query);
      return { records: page.records.map((r) => scriptRecord(r, t.fields)) };
    },
    get: async (tx, a) => {
      const t = await load(tx, a.tableId);
      const ctx = { tx, workspaceId: env.workspaceId, userId: env.userId, table: t.table };
      try {
        return scriptRecord(await getRecord(ctx, a.recordId), t.fields);
      } catch (err) {
        if (env.describe(err) !== null) return null;
        throw err;
      }
    },
    create: async (tx, a) => {
      mayWrite('record:create');
      const t = await load(tx, a.tableId);
      const ctx = {
        tx,
        workspaceId: env.workspaceId,
        userId: env.userId,
        role: env.role,
        table: t.table,
        entitlements: env.entitlements,
        automation: { automationId: env.automationId },
      };
      const created = await createRecords(
        ctx,
        a.records.map((r) => byId(t, r.fields))
      );
      return { ids: created.map((r) => r.id) };
    },
    update: async (tx, a) => {
      mayWrite('record:update');
      const t = await load(tx, a.tableId);
      const ctx = {
        tx,
        workspaceId: env.workspaceId,
        userId: env.userId,
        role: env.role,
        table: t.table,
        entitlements: env.entitlements,
        automation: { automationId: env.automationId },
      };
      const updated = await updateRecords(
        ctx,
        a.records.map((r) => ({ id: r.id, fields: byId(t, r.fields) }))
      );
      return { ids: updated.map((r) => r.id) };
    },
    delete: async (tx, a) => {
      mayWrite('record:delete');
      const t = await load(tx, a.tableId);
      const ctx = {
        tx,
        workspaceId: env.workspaceId,
        userId: env.userId,
        role: env.role,
        table: t.table,
        entitlements: env.entitlements,
        automation: { automationId: env.automationId },
      };
      await deleteRecords(ctx, [...new Set(a.recordIds)]);
      return { ids: a.recordIds };
    },
    fetch: async (_tx, a) => {
      if (!env.http) fail("This server isn't set up to make requests.");
      fetches += 1;
      if (fetches > MAX_SCRIPT_FETCHES)
        fail(`A script makes at most ${MAX_SCRIPT_FETCHES} requests.`);
      try {
        const res = await env.http(a.url, {
          method: a.method,
          headers: a.headers,
          ...(a.body !== null && a.method !== 'GET' && a.method !== 'HEAD' ? { body: a.body } : {}),
          maxBytes: MAX_FETCH_BYTES,
          timeoutMs: FETCH_TIMEOUT_MS,
        });
        const headers: Record<string, string> = {};
        res.headers.forEach((value, name) => {
          headers[name.toLowerCase()] = value;
        });
        return { status: res.status, statusText: res.statusText, headers, body: res.text() };
      } catch (err) {
        if (err instanceof SafeFetchError) fail(`The request failed: ${err.message}.`);
        // The workspace's outbound rate, after the gate's wait: the script may retry.
        if (err instanceof OutboundDeferred) {
          fail(
            `Too many outbound requests from this workspace; try again in ${err.retryAfterSeconds} s.`
          );
        }
        throw err;
      }
    },
  };

  return async (method, raw) => {
    const parsed = argsSchemas[method].safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      fail(
        `Invalid ${method} call: ${issue ? `${issue.path.join('.') || 'arguments'}: ${issue.message}` : 'bad arguments'}`
      );
    }
    const run = methods[method] as (tx: Transaction, args: unknown) => Promise<unknown>;
    if (method === 'fetch') return run(env.tx, parsed.data);
    try {
      // Its own savepoint: a refused write rolls back alone and the script may go on.
      return await env.tx.transaction((sp) => run(sp, parsed.data));
    } catch (err) {
      if (err instanceof ScriptCallError) throw err;
      const message = env.describe(err);
      if (message !== null) fail(message);
      throw err;
    }
  };
}

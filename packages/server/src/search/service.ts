import {
  SEARCH_EXCERPT_MAX,
  SEARCH_MATCHES_MAX,
  SEARCH_TABLES_PER_PAGE,
  type SearchHit,
  type SearchQuery,
  type SearchResult,
} from '@openrows/shared';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Principal } from '../auth/sessions.js';
import { assertAllowed, authorize, type ResolvedResource } from '../authz/policy.js';
import { resolveResource } from '../authz/resolve.js';
import { setScope } from '../authz/scope.js';
import {
  baseMembers,
  bases,
  type Database,
  type Transaction,
  workspaceMembers,
  workspaces,
} from '../db/index.js';
import type { TableRow } from '../fields/service.js';
import { AppError } from '../lib/errors.js';
import type { FieldVisibility } from '../realtime/projection.js';
import { queryRecords, tableFields } from '../records/service.js';
import { liveTables } from '../tables/service.js';

/**
 * Record search across tables and bases (`GET /api/v1/search`).
 *
 * Nothing here is a second search engine: each table is searched by the view query engine's own
 * `search` (find in view: text, select, number and link fields, ignoring case, as SQL over the
 * table's record table), through `queryRecords` with the fields the caller may read. Results are
 * always current (there's no separate index to go stale); trigram indexes created for saved
 * views' filters (src/indexes) serve the match where they exist.
 *
 * Access is decided per base and table exactly as the record routes decide it: the base is
 * resolved through `authz_resolve` (workspace and base roles, trash, suspended workspaces, the
 * workspace's token policy) and every table goes through `authorize(principal, 'record:read')`
 * (a token's scopes and grants included). A base the caller doesn't reach is skipped without a
 * trace; interface-only collaborators have no role on the base, so its records never show.
 * Fields hidden from the caller (`FieldVisibility`) are neither searched nor answered.
 *
 * A page searches tables in a fixed order (the caller's workspaces, oldest first, their bases
 * oldest first, then bases shared with them directly; `firstBaseId` first) and records by id,
 * and stops at `pageSize` hits, `SEARCH_TABLES_PER_PAGE` tables or `SEARCH_TIME_BUDGET_MS`,
 * whichever comes first. `offset` resumes at the table (and record) where it stopped. A table
 * whose search runs past `SEARCH_STATEMENT_TIMEOUT_MS` is skipped and listed in
 * `skippedTables`.
 */

/** A page stops starting new tables after this long; `offset` continues. */
export const SEARCH_TIME_BUDGET_MS = 1500;
/** One table's search is cancelled (and the table skipped) after this long. */
export const SEARCH_STATEMENT_TIMEOUT_MS = 2000;
/** Most bases one page resolves (bases the caller can't read count too). */
export const SEARCH_BASES_PER_PAGE = 200;

export interface SearchDeps {
  db: Database;
  visibility: FieldVisibility;
  /** The clock (tests stop the time budget). */
  now?: () => number;
}

/** A base the caller may reach, before its access is checked. */
interface Candidate {
  id: string;
  workspaceId: string;
}

/** Where the next page starts: a base, maybe a table of it, maybe a record cursor in that. */
export interface SearchPosition {
  b: string;
  t?: string;
  c?: string;
}

export function encodeSearchOffset(position: SearchPosition): string {
  return Buffer.from(JSON.stringify(position)).toString('base64url');
}

export function decodeSearchOffset(offset: string): SearchPosition | null {
  try {
    const v = JSON.parse(Buffer.from(offset, 'base64url').toString('utf8')) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    const { b, t, c } = v as Record<string, unknown>;
    const uuid = (x: unknown) => typeof x === 'string' && UUID.test(x);
    if (!uuid(b)) return null;
    if (t !== undefined && !uuid(t)) return null;
    if (c !== undefined && (typeof c !== 'string' || c.length > 5000 || t === undefined)) {
      return null;
    }
    return {
      b: b as string,
      ...(t !== undefined ? { t: t as string } : {}),
      ...(c !== undefined ? { c: c as string } : {}),
    };
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalidOffset(): never {
  throw new AppError('VALIDATION_FAILED', {
    detail: 'The offset is invalid or belongs to another search.',
    extensions: { errors: [{ path: 'offset', message: 'Not an offset of this search.' }] },
  });
}

/**
 * The text of a matching field as a hit shows it: the whole text when it's short, else `max`
 * characters around the first match (a third of them before it), with "…" where it was cut.
 * Runs of white space (line breaks) become one space.
 */
export function excerpt(text: string, term: string, max = SEARCH_EXCERPT_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const at = flat.toLowerCase().indexOf(term.toLowerCase());
  const start = Math.min(at < 0 ? 0 : Math.max(0, at - Math.floor(max / 3)), flat.length - max);
  const end = start + max;
  let out = flat.slice(start, end);
  if (start > 0) out = `…${out.slice(1)}`;
  if (end < flat.length) out = `${out.slice(0, -1)}…`;
  return out;
}

/** Postgres cancelled the statement (our `statement_timeout`). */
function isTimeout(err: unknown): boolean {
  for (let e = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === '57014') return true;
  }
  return false;
}

/**
 * The bases the caller is a member of or a collaborator on, in search order: their
 * workspaces (oldest first) with each one's live bases (oldest first), then bases shared with
 * them directly. Only candidates: each is authorized before it's searched.
 */
async function candidateBases(tx: Transaction, userId: string): Promise<Candidate[]> {
  await setScope(tx, { userId });
  const memberships = await tx
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, userId), isNull(workspaces.deletedAt)))
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id));
  const direct = await tx
    .select({ id: baseMembers.baseId, workspaceId: baseMembers.workspaceId })
    .from(baseMembers)
    .where(eq(baseMembers.userId, userId))
    .orderBy(asc(baseMembers.createdAt), asc(baseMembers.baseId));
  const out: Candidate[] = [];
  for (const { workspaceId } of memberships) {
    await setScope(tx, { userId, workspaceId });
    const rows = await tx
      .select({ id: bases.id, workspaceId: bases.workspaceId })
      .from(bases)
      .where(and(eq(bases.workspaceId, workspaceId), isNull(bases.deletedAt)))
      .orderBy(asc(bases.createdAt), asc(bases.id));
    out.push(...rows);
  }
  const listed = new Set(out.map((b) => b.id));
  for (const b of direct) if (!listed.has(b.id)) out.push(b);
  return out;
}

/** The base as a table resource for `authorize` (tables have no roles of their own). */
const asTable = (base: ResolvedResource, tableId: string): ResolvedResource => ({
  ...base,
  kind: 'table',
  id: tableId,
});

/** One page of a search: see the module comment. */
export async function searchRecords(
  deps: SearchDeps,
  principal: Principal,
  query: SearchQuery
): Promise<SearchResult> {
  const { db, visibility } = deps;
  const now = deps.now ?? Date.now;
  const started = now();
  const userId = principal.user.id;
  const term = query.q;
  const from = query.offset === undefined ? null : decodeSearchOffset(query.offset);
  if (query.offset !== undefined && !from) invalidOffset();

  return db.transaction(
    async (tx) => {
      await tx.execute(
        sql`SELECT set_config('statement_timeout', ${String(SEARCH_STATEMENT_TIMEOUT_MS)}, true)`
      );

      let candidates: Candidate[];
      if (query.baseId) {
        // One base, named by the caller: refused like any route on it (404 outside their access).
        const resolved = await resolveResource(tx, 'base', query.baseId, userId);
        assertAllowed(
          authorize(principal, 'record:read', resolved && asTable(resolved, query.baseId))
        );
        candidates = resolved ? [{ id: query.baseId, workspaceId: resolved.workspaceId }] : [];
      } else {
        candidates = await candidateBases(tx, userId);
        const first = candidates.findIndex((b) => b.id === query.firstBaseId);
        if (first > 0) candidates.unshift(...candidates.splice(first, 1));
      }

      let baseIndex = 0;
      if (from) {
        baseIndex = candidates.findIndex((b) => b.id === from.b);
        if (baseIndex < 0) invalidOffset();
      }

      const records: SearchHit[] = [];
      const skippedTables: { baseId: string; tableId: string }[] = [];
      let next: SearchPosition | undefined;
      let tablesSearched = 0;
      let basesResolved = 0;
      // Every page searches at least one table, so paging always gets further.
      const outOfBudget = () =>
        tablesSearched > 0 &&
        (tablesSearched >= SEARCH_TABLES_PER_PAGE || now() - started >= SEARCH_TIME_BUDGET_MS);

      search: for (; baseIndex < candidates.length; baseIndex++) {
        const candidate = candidates[baseIndex] as Candidate;
        const resuming = from?.b === candidate.id ? from : null;
        if (records.length >= query.pageSize || basesResolved >= SEARCH_BASES_PER_PAGE) {
          next = { b: candidate.id };
          break;
        }
        basesResolved++;
        const resolved = await resolveResource(tx, 'base', candidate.id, userId);
        if (!resolved) continue;
        if (!authorize(principal, 'record:read', asTable(resolved, resolved.id)).allowed) continue;

        await setScope(tx, { userId, workspaceId: resolved.workspaceId });
        const [base] = await tx
          .select({ name: bases.name })
          .from(bases)
          .where(eq(bases.id, candidate.id));
        if (!base) continue;
        const tables = await liveTables(tx, candidate.id);
        let tableIndex = 0;
        if (resuming?.t) {
          tableIndex = tables.findIndex((t) => t.id === resuming.t);
          if (tableIndex < 0) invalidOffset();
        }

        for (; tableIndex < tables.length; tableIndex++) {
          const table = tables[tableIndex] as TableRow;
          if (records.length >= query.pageSize || outOfBudget()) {
            next = { b: candidate.id, t: table.id };
            break search;
          }
          const decision = authorize(principal, 'record:read', asTable(resolved, table.id));
          if (!decision.allowed) continue;
          tablesSearched++;
          const cursor = resuming?.t === table.id ? resuming.c : undefined;
          const page = await searchTable(tx, {
            table,
            workspaceId: resolved.workspaceId,
            userId,
            hidden: visibility.hiddenFields({ userId, role: decision.role }, table.id),
            term,
            limit: query.pageSize - records.length,
            cursor,
          });
          if (page === 'timeout') {
            skippedTables.push({ baseId: candidate.id, tableId: table.id });
            continue;
          }
          for (const hit of page.hits) {
            records.push({
              ...hit,
              baseId: candidate.id,
              baseName: base.name,
              tableId: table.id,
              tableName: table.name,
            });
          }
          if (page.nextCursor) {
            next = { b: candidate.id, t: table.id, c: page.nextCursor };
            break search;
          }
        }
      }

      return {
        records,
        ...(next ? { offset: encodeSearchOffset(next) } : {}),
        ...(skippedTables.length ? { skippedTables } : {}),
      };
    },
    { accessMode: 'read only' }
  );
}

/**
 * One table's matching records (at most `limit`), in record id order after `cursor`, through
 * the view query engine with the fields the caller may read; 'timeout' when the statement ran
 * past the timeout (the savepoint keeps the request's transaction usable).
 */
async function searchTable(
  tx: Transaction,
  input: {
    table: TableRow;
    workspaceId: string;
    userId: string;
    hidden: ReadonlySet<string>;
    term: string;
    limit: number;
    cursor: string | undefined;
  }
) {
  const { table, workspaceId, userId, hidden, term } = input;
  const fields = (await tableFields(tx, table)).filter((f) => !hidden.has(f.row.id));
  if (fields.length === 0) return { hits: [], nextCursor: null };
  const primary = fields.find((f) => f.row.isPrimary);
  let page: Awaited<ReturnType<typeof queryRecords>>;
  try {
    page = await tx.transaction((sp) =>
      queryRecords(
        { tx: sp, workspaceId, userId, table },
        {
          query: { search: term, fields: fields.map((f) => f.row.id), sorts: [], groupBy: [] },
          limit: input.limit,
          count: false,
          groups: false,
          ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        }
      )
    );
  } catch (err) {
    if (isTimeout(err)) return 'timeout' as const;
    throw err;
  }
  const lower = term.toLowerCase();
  const hits = page.records.map((r) => {
    const text = (f: (typeof fields)[number]) =>
      f.def.format(r.fields[f.row.id] ?? null, f.options);
    const matches: SearchHit['matches'] = [];
    for (const f of fields) {
      if (f === primary || matches.length >= SEARCH_MATCHES_MAX) continue;
      const value = text(f);
      if (value.toLowerCase().includes(lower)) {
        matches.push({ fieldId: f.row.id, fieldName: f.row.name, text: excerpt(value, term) });
      }
    }
    return { id: r.id, name: primary ? text(primary) : '', matches };
  });
  return { hits, nextCursor: page.nextCursor };
}

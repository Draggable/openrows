import { z } from 'zod';

/**
 * Record search across tables and bases (`GET /api/v1/search`): the records whose readable
 * text, select, number or link fields contain the query (ignoring case), in every table the
 * caller may read records of. Each page searches a bounded number of tables (and stops at a
 * time budget), so a query never scans an unbounded amount of data in one request; `offset`
 * continues where the page stopped.
 */

/** Shortest query, in characters after trimming: shorter ones match almost everything. */
export const SEARCH_QUERY_MIN = 3;
/** Longest query, in characters. */
export const SEARCH_QUERY_MAX = 200;
/** Records per page by default. */
export const SEARCH_PAGE_DEFAULT = 20;
/** Most records one page answers. */
export const SEARCH_PAGE_MAX = 50;
/** Most tables one page searches; `offset` continues with the next one. */
export const SEARCH_TABLES_PER_PAGE = 50;
/** Most matching fields a hit lists. */
export const SEARCH_MATCHES_MAX = 3;
/** Longest text of a matching field in a hit (an excerpt around the match). */
export const SEARCH_EXCERPT_MAX = 120;

export const searchQuerySchema = z
  .object({
    /** The text to find. */
    q: z.string().trim().min(SEARCH_QUERY_MIN).max(SEARCH_QUERY_MAX),
    /** Only this base. */
    baseId: z.uuid().optional(),
    /** Search this base before the others (the app passes the open base). */
    firstBaseId: z.uuid().optional(),
    pageSize: z.coerce.number().int().min(1).max(SEARCH_PAGE_MAX).default(SEARCH_PAGE_DEFAULT),
    /** The previous page's `offset`. */
    offset: z.string().min(1).max(10_000).optional(),
  })
  .strict();
export type SearchQuery = z.output<typeof searchQuerySchema>;

/** A field of a hit whose text contains the query. */
export const SearchMatchSchema = z.object({
  fieldId: z.uuid(),
  fieldName: z.string(),
  /** The field's display text, or an excerpt of it around the match. */
  text: z.string(),
});
export type SearchMatch = z.infer<typeof SearchMatchSchema>;

export const SearchHitSchema = z.object({
  /** The record's id. */
  id: z.uuid(),
  baseId: z.uuid(),
  baseName: z.string(),
  tableId: z.uuid(),
  tableName: z.string(),
  /** The record's primary field as text; empty when the cell is empty. */
  name: z.string(),
  /** Other fields whose text contains the query (at most `SEARCH_MATCHES_MAX`). */
  matches: z.array(SearchMatchSchema),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchResultSchema = z.object({
  records: z.array(SearchHitSchema),
  /** Present while there is more to search: pass it back for the next page. */
  offset: z.string().optional(),
  /**
   * Tables this page skipped because searching them took too long (very large tables without
   * an index for the query). Their records may match but aren't listed.
   */
  skippedTables: z.array(z.object({ baseId: z.uuid(), tableId: z.uuid() })).optional(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

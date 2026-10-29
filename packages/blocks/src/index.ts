/**
 * @openrows/blocks: the typed SDK for OpenRows extensions.
 *
 * An extension is a manifest and a bundle (HTML, CSS and JS) installed on a base. OpenRows runs
 * it in a sandboxed frame with no network, cookies or storage, and gives it `window.openrows`:
 * the API below, answered over `postMessage` by the app as the signed-in person. Each call needs
 * a scope the manifest declares; anything else is refused.
 *
 * ```ts
 * import { initializeBlock } from '@openrows/blocks';
 *
 * const block = await initializeBlock();
 * const table = block.getTable('Tasks');
 * const records = await block.selectRecords(table.id, { fields: ['Name', 'Status'] });
 * block.watchRecords(table.id, () => render());
 * ```
 */

/** What an extension may ask for in its manifest. */
export type BlockScope =
  | 'records:read'
  | 'records:write'
  | 'cursor:read'
  | 'settings:write'
  | 'embed:frames';

/** The scopes, in the order OpenRows lists them. */
export const BLOCK_SCOPES: readonly BlockScope[] = [
  'records:read',
  'records:write',
  'cursor:read',
  'settings:write',
  'embed:frames',
];

/** An extension's `manifest` (the JSON next to its bundle). */
export interface BlockManifest {
  manifestVersion: 1;
  name: string;
  description?: string;
  /** `1.0.0` style. */
  version?: string;
  scopes: BlockScope[];
}

/** What you install: the manifest and the bundle, as one JSON file. */
export interface BlockPackage {
  manifest: BlockManifest;
  bundle: { html?: string; css?: string; js?: string };
}

export interface BlockField {
  id: string;
  name: string;
  /** OpenRows' field type: `text`, `number`, `singleSelect`, `url`… */
  type: string;
  description: string | null;
  options: unknown;
  /** Formula, lookup and other read-only fields. */
  isComputed: boolean;
}

export interface BlockView {
  id: string;
  name: string;
  type: string;
}

export interface BlockTable {
  id: string;
  name: string;
  description: string | null;
  primaryFieldId: string | null;
  fields: BlockField[];
  views: BlockView[];
}

/** The base: no tables without `records:read`. */
export interface BlockBase {
  id: string;
  name: string;
  tables: BlockTable[];
}

/** A record: cell values and their display text, both by field id. */
export interface BlockRecord {
  id: string;
  /** The primary field's text. */
  name: string;
  createdTime: string;
  cells: Record<string, unknown>;
  strings: Record<string, string>;
}

/** Where the person is: the open table and view, the selected record and field. */
export interface BlockCursor {
  tableId: string | null;
  viewId: string | null;
  recordId: string | null;
  fieldId: string | null;
}

export type BlockTheme = 'light' | 'dark';
export type BlockSettings = Record<string, unknown>;

/** A table, field or view by id or name, or an object with its `id`. */
export type Ref = string | { id: string };

export interface SelectOptions {
  view?: Ref;
  fields?: Ref[];
  sorts?: { field: Ref; direction?: 'asc' | 'desc' }[];
  recordIds?: (string | { id: string })[];
  /** At most 5,000 (the default too). */
  limit?: number;
}

export interface BlockEvents {
  cursor: BlockCursor;
  settings: BlockSettings;
  theme: BlockTheme;
  base: BlockBase;
}

/** `window.openrows`. Values are copies: change them freely. */
export interface Block {
  readonly installation: { id: string; name: string };
  readonly scopes: readonly BlockScope[];
  hasScope(scope: BlockScope): boolean;
  readonly theme: BlockTheme;
  readonly base: BlockBase;
  /** Null without `cursor:read`. */
  readonly cursor: BlockCursor | null;
  readonly settings: BlockSettings;
  /** `settings:write`, and the person may change settings (editors and up). */
  readonly canEditSettings: boolean;
  getTable(table: Ref): BlockTable;
  getTableIfExists(table: Ref): BlockTable | null;
  /** Answers the unsubscribe. */
  on<E extends keyof BlockEvents>(event: E, callback: (value: BlockEvents[E]) => void): () => void;
  /** `records:read`. */
  selectRecords(table: Ref, options?: SelectOptions): Promise<BlockRecord[]>;
  /** `records:read`; null when the record is gone. */
  getRecord(table: Ref, recordId: string | { id: string }): Promise<BlockRecord | null>;
  /** `records:write`; at most 50 per call; cells by field id or name. Answers the new ids. */
  createRecords(
    table: Ref,
    records: { fields: Record<string, unknown> }[] | Record<string, unknown>[]
  ): Promise<string[]>;
  /** `records:write`; at most 50 per call. */
  updateRecords(
    table: Ref,
    records: { id: string; fields: Record<string, unknown> }[]
  ): Promise<void>;
  /** `records:write`; at most 50 per call. */
  deleteRecords(table: Ref, records: (string | { id: string })[]): Promise<void>;
  /** `records:read`: calls back after the table's records change. Answers the unsubscribe. */
  watchRecords(table: Ref, callback: () => void): () => void;
  /** `settings:write`: replaces this installation's settings (a JSON object, 64 KB). */
  setSettings(settings: BlockSettings): Promise<void>;
  /** Opens an http(s) link in a new tab (after a click in the extension). */
  openUrl(url: string): Promise<void>;
}

declare global {
  var openrows: Block | undefined;
}

/**
 * The extension's API. OpenRows sets it before the bundle runs, so this resolves at once inside
 * an extension; anywhere else it rejects.
 */
export async function initializeBlock(): Promise<Block> {
  const block = globalThis.openrows;
  if (!block) {
    throw new Error('@openrows/blocks runs inside an OpenRows extension frame.');
  }
  return block;
}

/** Checks a package's manifest before you upload it; answers the problems (none: valid). */
export function manifestProblems(manifest: unknown): string[] {
  const problems: string[] = [];
  if (!manifest || typeof manifest !== 'object') return ['The manifest must be an object.'];
  const m = manifest as Record<string, unknown>;
  if (m['manifestVersion'] !== 1) problems.push('manifestVersion must be 1.');
  if (typeof m['name'] !== 'string' || !m['name'].trim() || m['name'].length > 100) {
    problems.push('name must be 1 to 100 characters.');
  }
  if (!Array.isArray(m['scopes'])) problems.push('scopes must be a list.');
  else {
    for (const s of m['scopes']) {
      if (!BLOCK_SCOPES.includes(s as BlockScope)) problems.push(`Unknown scope: ${String(s)}.`);
    }
    if (new Set(m['scopes']).size !== m['scopes'].length) problems.push('List each scope once.');
  }
  return problems;
}

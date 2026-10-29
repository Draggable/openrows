/**
 * Automation tokens: `{{trigger.record.fields.Name}}`, `{{steps.1.records[0].id}}`.
 * A small path language, never evaluated as code: a token is a root (`trigger` or `steps`)
 * followed by `.key` (any text but `.`, `[`, `]`, `{`, `}`; spaces allowed, so
 * `fields.Due date` works), `[n]` or `["key"]`. Lookups only read own properties of plain objects
 * and indexes of arrays (never `__proto__`, `constructor` or `prototype`); a missing value is
 * empty.
 *
 * A string that is exactly one token takes the token's value as it is (a number stays a number,
 * a list of records stays a list, for link cells); otherwise each token is replaced by its text.
 */

export const TEMPLATE_ROOTS = ['trigger', 'steps'] as const;
/** Most tokens one string may hold, and the deepest path. */
export const MAX_TEMPLATE_TOKENS = 50;
export const MAX_TEMPLATE_PATH = 12;
/** Longest text a token renders to inside a string. */
const MAX_RENDERED = 100_000;

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const TOKEN_RE = /\{\{([^{}]*)\}\}/g;

export class TemplateError extends Error {
  override name = 'TemplateError';
}

export type PathKey = string | number;

/** A token's path: `trigger.record.fields["Due date"]` → `['trigger', 'record', 'fields', 'Due date']`. */
export function parsePath(text: string): PathKey[] {
  const src = text.trim();
  const keys: PathKey[] = [];
  let i = 0;
  const root = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src);
  if (!root) throw new TemplateError(`"{{${text}}}" doesn't start with trigger or steps.`);
  keys.push(root[0]);
  i = root[0].length;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '.') {
      let j = i + 1;
      while (j < src.length && !'.[]'.includes(src[j] ?? '')) j++;
      const key = src.slice(i + 1, j).trim();
      if (!key) throw new TemplateError(`"{{${text}}}" has an empty step.`);
      keys.push(/^\d+$/.test(key) ? Number(key) : key);
      i = j;
    } else if (ch === '[') {
      const m = /^\[\s*(?:(\d+)|"([^"]*)"|'([^']*)')\s*\]/.exec(src.slice(i));
      if (!m) throw new TemplateError(`"{{${text}}}" has a malformed [...].`);
      keys.push(m[1] !== undefined ? Number(m[1]) : (m[2] ?? m[3] ?? ''));
      i += m[0].length;
    } else {
      throw new TemplateError(`"{{${text}}}" isn't a valid token.`);
    }
    if (keys.length > MAX_TEMPLATE_PATH) throw new TemplateError(`"{{${text}}}" is too deep.`);
  }
  if (!(TEMPLATE_ROOTS as readonly string[]).includes(String(keys[0]))) {
    throw new TemplateError(`"{{${text}}}" doesn't start with trigger or steps.`);
  }
  return keys;
}

/** The token paths in a string (throws TemplateError on a malformed or excess token). */
export function templatePaths(text: string): PathKey[][] {
  const paths: PathKey[][] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    paths.push(parsePath(m[1] ?? ''));
    if (paths.length > MAX_TEMPLATE_TOKENS) {
      throw new TemplateError(`A value can hold at most ${MAX_TEMPLATE_TOKENS} tokens.`);
    }
  }
  return paths;
}

/** Every token path in a JSON value (strings inside arrays and objects too). */
export function valuePaths(value: unknown): PathKey[][] {
  if (typeof value === 'string') return templatePaths(value);
  if (Array.isArray(value)) return value.flatMap(valuePaths);
  if (isPlainObject(value)) return Object.values(value).flatMap(valuePaths);
  return [];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Reads a path in the context: own properties and array indexes only; undefined when missing. */
export function lookup(context: Record<string, unknown>, path: readonly PathKey[]): unknown {
  let cur: unknown = context;
  for (const key of path) {
    if (Array.isArray(cur)) {
      cur = typeof key === 'number' ? cur[key] : undefined;
    } else if (isPlainObject(cur)) {
      const k = String(key);
      cur = !FORBIDDEN.has(k) && Object.hasOwn(cur, k) ? cur[k] : undefined;
    } else {
      return undefined;
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** A value as text inside a string: lists joined by commas, linked records and people by name. */
export function valueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(valueText).join(', ');
  if (isPlainObject(value)) {
    for (const key of ['name', 'filename', 'text']) {
      if (typeof value[key] === 'string') return value[key];
    }
    return JSON.stringify(value);
  }
  return '';
}

/** Renders one string. Throws TemplateError on a malformed token. */
export function renderTemplate(text: string, context: Record<string, unknown>): unknown {
  const paths = templatePaths(text);
  if (paths.length === 0) return text;
  const whole = /^\{\{([^{}]*)\}\}$/.exec(text);
  if (whole) return lookup(context, parsePath(whole[1] ?? '')) ?? null;
  let out = '';
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    out += text.slice(last, m.index);
    out += valueText(lookup(context, parsePath(m[1] ?? ''))).slice(0, MAX_RENDERED);
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

/** Renders every string in a JSON value (arrays and objects are walked, keys left alone). */
export function renderValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === 'string') return renderTemplate(value, context);
  if (Array.isArray(value)) return value.map((v) => renderValue(v, context));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderValue(v, context)]));
  }
  return value;
}

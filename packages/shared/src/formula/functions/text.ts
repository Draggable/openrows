import { RE2JS, RE2JSException } from 're2js';
import type { FunctionImpl } from './env.js';
import { checkText, fail, toInteger, toList, toText } from './values.js';

/**
 * Text functions. Positions are 1-based and count characters (code points), as in Airtable.
 * The REGEX_* functions run on RE2 (re2js: linear time, no backreferences or lookaround), so no
 * pattern can make an evaluation backtrack exponentially (the legacy ReDoS).
 */

const chars = (s: string) => Array.from(s);

/** Longest regular expression accepted. */
export const MAX_REGEX_LENGTH = 1000;

const regexCache = new Map<string, RE2JS>();

function regex(pattern: string): RE2JS {
  if (pattern.length > MAX_REGEX_LENGTH) fail('The regular expression is too long');
  const cached = regexCache.get(pattern);
  if (cached) return cached;
  let compiled: RE2JS;
  try {
    compiled = RE2JS.compile(pattern);
  } catch (e) {
    if (e instanceof RE2JSException) fail(`Invalid regular expression: ${e.message}`);
    throw e;
  }
  if (regexCache.size >= 500) regexCache.clear();
  regexCache.set(pattern, compiled);
  return compiled;
}

function indexOf(needle: string, haystack: string, from: number, ignoreCase: boolean): number {
  const h = chars(ignoreCase ? haystack.toLowerCase() : haystack);
  const n = chars(ignoreCase ? needle.toLowerCase() : needle);
  const start = Math.max(0, from - 1);
  if (n.length === 0) return start < h.length || start === 0 ? start + 1 : 0;
  outer: for (let i = start; i + n.length <= h.length; i++) {
    for (let j = 0; j < n.length; j++) if (h[i + j] !== n[j]) continue outer;
    return i + 1;
  }
  return 0;
}

export const TEXT_FUNCTIONS: Record<string, FunctionImpl> = {
  CONCATENATE: (args) => checkText(args.map(toText).join('')),
  LEFT: ([text, count]) => {
    const n = toInteger(count ?? null);
    if (n < 0) fail('LEFT needs a count of 0 or more');
    return chars(toText(text ?? null))
      .slice(0, n)
      .join('');
  },
  RIGHT: ([text, count]) => {
    const n = toInteger(count ?? null);
    if (n < 0) fail('RIGHT needs a count of 0 or more');
    const c = chars(toText(text ?? null));
    return n === 0 ? '' : c.slice(Math.max(0, c.length - n)).join('');
  },
  MID: ([text, start, count]) => {
    const s = toInteger(start ?? null);
    const n = toInteger(count ?? null);
    if (s < 1 || n < 0) fail('MID needs a start of 1 or more and a count of 0 or more');
    return chars(toText(text ?? null))
      .slice(s - 1, s - 1 + n)
      .join('');
  },
  FIND: ([needle, haystack, start]) =>
    indexOf(toText(needle ?? null), toText(haystack ?? null), toInteger(start ?? 1), false),
  SEARCH: ([needle, haystack, start]) => {
    const at = indexOf(
      toText(needle ?? null),
      toText(haystack ?? null),
      toInteger(start ?? 1),
      true
    );
    return at === 0 ? null : at;
  },
  SUBSTITUTE: ([text, from, to, index], env) => {
    const s = toText(text ?? null);
    const old = toText(from ?? null);
    const replacement = toText(to ?? null);
    if (old === '') return s;
    env.step(Math.ceil(s.length / 100));
    if (index === undefined || index === null) return checkText(s.split(old).join(replacement));
    const nth = toInteger(index);
    if (nth < 1) fail('SUBSTITUTE needs an index of 1 or more');
    let at = -1;
    for (let i = 0; i < nth; i++) {
      at = s.indexOf(old, at + 1);
      if (at < 0) return s;
    }
    return checkText(s.slice(0, at) + replacement + s.slice(at + old.length));
  },
  REPLACE: ([text, start, count, replacement]) => {
    const s = toInteger(start ?? null);
    const n = toInteger(count ?? null);
    if (s < 1 || n < 0) fail('REPLACE needs a start of 1 or more and a count of 0 or more');
    const c = chars(toText(text ?? null));
    return checkText(
      [...c.slice(0, s - 1), toText(replacement ?? null), ...c.slice(s - 1 + n)].join('')
    );
  },
  LEN: ([text]) => chars(toText(text ?? null)).length,
  TRIM: ([text]) => toText(text ?? null).trim(),
  UPPER: ([text]) => toText(text ?? null).toUpperCase(),
  LOWER: ([text]) => toText(text ?? null).toLowerCase(),
  REPT: ([text, count], env) => {
    const s = toText(text ?? null);
    const n = toInteger(count ?? null);
    if (n < 0) fail('REPT needs a count of 0 or more');
    if (s.length * n > 100_000) fail('The text is too long');
    env.step(Math.ceil((s.length * n) / 100));
    return s.repeat(n);
  },
  T: ([value]) => (typeof value === 'string' ? value : ''),
  ENCODE_URL_COMPONENT: ([text]) => {
    try {
      return encodeURIComponent(toText(text ?? null));
    } catch {
      return fail('The text has an unpaired surrogate');
    }
  },
  REGEX_MATCH: ([text, pattern], env) => {
    const s = toText(text ?? null);
    env.step(Math.ceil(s.length / 100));
    return regex(toText(pattern ?? null))
      .matcher(s)
      .find();
  },
  REGEX_EXTRACT: ([text, pattern], env) => {
    const s = toText(text ?? null);
    env.step(Math.ceil(s.length / 100));
    const m = regex(toText(pattern ?? null)).matcher(s);
    return m.find() ? (m.group(0) ?? '') : null;
  },
  REGEX_REPLACE: ([text, pattern, replacement], env) => {
    const s = toText(text ?? null);
    env.step(Math.ceil(s.length / 100));
    try {
      return checkText(
        regex(toText(pattern ?? null))
          .matcher(s)
          .replaceAll(toText(replacement ?? null))
      );
    } catch (e) {
      if (e instanceof RE2JSException) fail(`Invalid replacement: ${e.message}`);
      throw e;
    }
  },
  ARRAYJOIN: ([list, separator]) =>
    checkText(
      toList(list ?? null)
        .filter((x) => x !== null)
        .map(toText)
        .join(separator === undefined ? ', ' : toText(separator))
    ),
};

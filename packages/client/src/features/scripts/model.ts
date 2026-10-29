import { SCRIPT_API, SCRIPT_GLOBALS, type ScriptApiMember } from '@openrows/shared';
import type { HostTable } from './host';

// The Scripts page's helpers: the editor's completions and the runner's role rules.

export interface ScriptCompletion {
  label: string;
  detail: string;
  info: string;
  type: 'method' | 'property' | 'variable' | 'keyword' | 'text';
  /** What to insert, when it differs from the label. */
  apply?: string;
}

export interface CompletionResult {
  /** Offset into the text before the cursor where the replaced word starts. */
  from: number;
  options: ScriptCompletion[];
}

const KEYWORDS = ['await', 'const', 'let', 'for', 'of', 'if', 'else', 'return', 'try', 'catch'];

const member = (m: ScriptApiMember): ScriptCompletion => ({
  label: m.name,
  detail: m.signature.slice(m.name.length),
  info: m.doc,
  type: m.kind,
  ...(m.kind === 'method' ? { apply: `${m.name}(` } : {}),
});

/** Which API object a variable most likely holds, from its name (`table`, `tasksView`, …). */
function objectOf(name: string): string[] {
  if (name in SCRIPT_API) return [name];
  const lower = name.toLowerCase();
  if (/table$/.test(lower)) return ['table'];
  if (/view$/.test(lower)) return ['view'];
  if (/field$/.test(lower)) return ['field'];
  if (/(query|result)$/.test(lower)) return ['query'];
  if (/(record|^r|^rec)$/.test(lower)) return ['record'];
  return ['table', 'view', 'query', 'record', 'field'];
}

/**
 * Completions at the end of `before` (the text up to the cursor): table, field and view names
 * inside `getTable('…`, `getField('…`, `getView('…`; the members after `name.`; the globals and a
 * few keywords for a bare word. Null when there's nothing to offer.
 */
export function scriptCompletions(before: string, tables: HostTable[]): CompletionResult | null {
  const named =
    /\.(getTable|getTableIfExists|getField|getFieldIfExists|getView|getViewIfExists)\(\s*(['"`])([^'"`]*)$/.exec(
      before
    );
  if (named) {
    const [, fn = '', quote = "'", typed = ''] = named;
    const names = fn.startsWith('getTable')
      ? tables.map((t) => ({ name: t.name, where: 'table' }))
      : fn.startsWith('getField')
        ? tables.flatMap((t) => t.fields.map((f) => ({ name: f.name, where: t.name })))
        : tables.flatMap((t) => t.views.map((v) => ({ name: v.name, where: t.name })));
    const seen = new Set<string>();
    const options = names
      .filter((n) => !seen.has(n.name) && seen.add(n.name))
      .map(
        (n): ScriptCompletion => ({
          label: n.name,
          detail: n.where,
          info: '',
          type: 'text',
          apply: `${n.name.replaceAll('\\', '\\\\').replaceAll(quote, `\\${quote}`)}${quote})`,
        })
      );
    return { from: before.length - typed.length, options };
  }
  const dotted = /([A-Za-z_$][\w$]*)\.([\w$]*)$/.exec(before);
  if (dotted) {
    const [, object = '', typed = ''] = dotted;
    const seen = new Set<string>();
    const options = objectOf(object)
      .flatMap((o) => SCRIPT_API[o] ?? [])
      .filter((m) => !seen.has(m.name) && seen.add(m.name))
      .map(member);
    return { from: before.length - typed.length, options };
  }
  const word = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)$/.exec(before);
  if (word) {
    const typed = word[1] ?? '';
    return {
      from: before.length - typed.length,
      options: [
        ...SCRIPT_GLOBALS.map(
          (g): ScriptCompletion => ({ label: g, detail: '', info: '', type: 'variable' })
        ),
        ...KEYWORDS.map(
          (k): ScriptCompletion => ({ label: k, detail: '', info: '', type: 'keyword' })
        ),
      ],
    };
  }
  return null;
}

/** A blank script's starting code. */
export const BLANK_SCRIPT = [
  '// Scripts run in a sandbox with your permissions. Try base, input, output and session.',
  'const table = base.tables[0];',
  'const query = await table.selectRecordsAsync();',
  "output.text(table.name + ' has ' + query.records.length + ' records.');",
  '',
].join('\n');

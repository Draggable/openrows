/**
 * HTML for emails, escaped by default (fixes M3: record values and base names went into
 * templates unescaped). Interpolations in the `html` tag are escaped unless they are themselves
 * `html` fragments, so there is no way to forget.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

/** A trusted HTML fragment. Only the `html` tag creates one. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

type Interpolation = string | number | SafeHtml | readonly SafeHtml[] | null | undefined;

export function html(strings: TemplateStringsArray, ...values: Interpolation[]): SafeHtml {
  let out = strings[0] ?? '';
  values.forEach((v, i) => {
    if (v instanceof SafeHtml) out += v.value;
    else if (Array.isArray(v)) out += v.map((f: SafeHtml) => f.value).join('');
    else if (v !== null && v !== undefined) out += escapeHtml(String(v));
    out += strings[i + 1] ?? '';
  });
  return new SafeHtml(out);
}

/** An http(s) URL for an href, or undefined. Blocks `javascript:` and other schemes. */
export function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

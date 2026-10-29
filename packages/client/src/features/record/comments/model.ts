import { type Collaborator, mapMentionTokens, mentionToken } from '@openrows/shared';

/**
 * The comment composer's model. The composer holds the draft as segments:
 * text, and mentions shown as chips that stand for one person whatever their name says. On send
 * `toBody` writes the stored tokens (`@[Name](user:<id>)`); editing goes the other way with
 * `toSegments`.
 */

export type Segment = { text: string } | { userId: string; name: string };

export const isMention = (s: Segment): s is { userId: string; name: string } => 'userId' in s;

// A placeholder for tokens while splitting (taken out of the body first).
const MARK = '\u0001';

/** A stored body as segments: tokens become mentions (the directory's name when it has one). */
export function toSegments(
  body: string,
  nameOf: (userId: string) => string | undefined
): Segment[] {
  const mentions: { userId: string; name: string }[] = [];
  const marked = mapMentionTokens(body.replaceAll(MARK, ''), (userId, label) => {
    mentions.push({ userId, name: nameOf(userId) ?? label });
    return `${MARK}${mentions.length - 1}${MARK}`;
  });
  const out: Segment[] = [];
  marked.split(MARK).forEach((part, i) => {
    if (i % 2 === 1) {
      const m = mentions[Number(part)];
      if (m) out.push(m);
    } else if (part) out.push({ text: part });
  });
  return out;
}

/** The body to send: text as typed, each chip as its token; trimmed. */
export function toBody(segments: readonly Segment[]): string {
  return segments
    .map((s) => (isMention(s) ? mentionToken(s.userId, s.name) : s.text))
    .join('')
    .trim();
}

/** The `@query` being typed just before the caret, if any. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|[\s(])@([^\s@[\]()]{0,40})$/u.exec(text.slice(0, caret));
  if (!m) return null;
  const query = m[2] ?? '';
  return { start: caret - query.length - 1, query };
}

/** The most suggestions the mention list shows. */
export const MAX_SUGGESTIONS = 8;

/**
 * People to suggest for `query`: those who can be mentioned (access to the base), names (or
 * emails) starting with the query first, then containing it.
 */
export function mentionSuggestions(
  directory: readonly Collaborator[],
  mentionable: ReadonlySet<string> | undefined,
  query: string
): Collaborator[] {
  const q = query.toLocaleLowerCase();
  const allowed = directory.filter((c) => mentionable?.has(c.id) ?? false);
  const score = (c: Collaborator) => {
    const name = c.name.toLocaleLowerCase();
    const email = c.email?.toLocaleLowerCase() ?? '';
    if (name.startsWith(q) || name.split(/\s+/).some((w) => w.startsWith(q))) return 0;
    if (email.startsWith(q)) return 1;
    if (name.includes(q) || email.includes(q)) return 2;
    return -1;
  };
  return allowed
    .map((c) => ({ c, s: score(c) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s)
    .slice(0, MAX_SUGGESTIONS)
    .map((x) => x.c);
}

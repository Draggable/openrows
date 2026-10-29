import {
  MAX_SHARE_DOMAINS,
  MAX_SHARE_EMBED_ORIGINS,
  type Share,
  shareDomainSchema,
  shareEmbedOriginSchema,
  shareFrameAncestors,
} from '@openrows/shared';

/**
 * Share links: what the share dialogs and the public page compute. The token only
 * exists in the browser that made the link, right after making it (the server keeps its hash).
 */

/** The public page of a link. */
export function shareUrl(token: string, origin: string = window.location.origin): string {
  return `${origin}/s/${token}`;
}

/**
 * The expiry of a date picked as `YYYY-MM-DD`: the end of that day in the browser's time zone,
 * as ISO. `null` for no date or an unreadable one.
 */
export function expiryOf(day: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  return Number.isNaN(end.getTime()) ? null : end.toISOString();
}

/** Today as `YYYY-MM-DD` in the browser's zone: the earliest expiry the date picker offers. */
export function today(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/** One line about a link: when it was made and until when it works. */
export function shareSummary(share: Share): string {
  const made = `Created ${dateFormat.format(new Date(share.createdAt))}`;
  if (share.expired) return `${made} · Expired`;
  if (!share.expiresAt) return `${made} · No expiry`;
  return `${made} · Expires ${dateFormat.format(new Date(share.expiresAt))}`;
}

/** What a link asks of viewers and lets them do, as short labels for its row. */
export function shareBadges(share: Share): string[] {
  const out: string[] = [];
  if (share.hasPassword) out.push('Password');
  if (share.allowedDomains.length > 0) out.push(`Only ${share.allowedDomains.join(', ')}`);
  out.push(share.allowCopy ? 'Copying allowed' : 'No copying');
  if (share.allowDownload) out.push('CSV download');
  const n = share.embedOrigins.length;
  if (n > 0) {
    out.push(
      shareFrameAncestors(share).length > 0
        ? `Embeddable on ${n} site${n === 1 ? '' : 's'}`
        : 'Embedding blocked (restricted link)'
    );
  }
  return out;
}

/** The theme of an embedded link: `auto` follows the visitor's system setting. */
export const EMBED_THEMES = ['light', 'dark', 'auto'] as const;
export type EmbedTheme = (typeof EMBED_THEMES)[number];

/** The embed page of a link, framed by the link's embed origins only. */
export function embedUrl(
  token: string,
  theme: EmbedTheme = 'light',
  origin: string = window.location.origin
): string {
  return `${origin}/embed/${token}?theme=${theme}`;
}

const escapeAttribute = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The HTML to paste into a page on an allowed origin: a lazy, borderless iframe of the
 * embed page. `title` names it for screen readers (escaped: it is the view's or base's name).
 */
export function embedSnippet(url: string, title: string): string {
  return `<iframe src="${escapeAttribute(url)}" title="${escapeAttribute(title)}" width="100%" height="533" style="border: 1px solid #e4e0d6; border-radius: 6px;" loading="lazy" referrerpolicy="no-referrer"></iframe>`;
}

/**
 * The embed origins typed as a list (commas, spaces or new lines between them): normalized
 * (`https://Example.com/` is `https://example.com`) and deduplicated, or the first entry that
 * isn't an https origin.
 */
export function parseEmbedOrigins(
  text: string
): { origins: string[]; error: null } | { origins: null; error: string } {
  const origins: string[] = [];
  for (const entry of text.split(/[\s,;]+/).filter(Boolean)) {
    const parsed = shareEmbedOriginSchema.safeParse(entry);
    if (!parsed.success) {
      return { origins: null, error: `“${entry}” isn’t an https origin like https://example.com.` };
    }
    if (!origins.includes(parsed.data)) origins.push(parsed.data);
  }
  if (origins.length > MAX_SHARE_EMBED_ORIGINS) {
    return { origins: null, error: `At most ${MAX_SHARE_EMBED_ORIGINS} sites.` };
  }
  return { origins, error: null };
}

/**
 * The allowed email domains typed as a list (commas, spaces or new lines between them):
 * normalized and deduplicated, or the first entry that isn't a domain (`@example.com` and
 * `https://example.com` are forgiven: their domain is taken).
 */
export function parseDomains(
  text: string
): { domains: string[]; error: null } | { domains: null; error: string } {
  const entries = text
    .split(/[\s,;]+/)
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) =>
      e
        .replace(/^https?:\/\//i, '')
        .replace(/^.*@/, '')
        .replace(/\/.*$/, '')
    );
  const domains: string[] = [];
  for (const entry of entries) {
    const parsed = shareDomainSchema.safeParse(entry);
    if (!parsed.success) return { domains: null, error: `“${entry}” isn’t a domain.` };
    if (!domains.includes(parsed.data)) domains.push(parsed.data);
  }
  if (domains.length > MAX_SHARE_DOMAINS) {
    return { domains: null, error: `At most ${MAX_SHARE_DOMAINS} domains.` };
  }
  return { domains, error: null };
}

/** The `returnTo` of the sign-in a domain-limited link asks for: back to the link. */
export function sharePath(token: string): string {
  return `/s/${token}`;
}

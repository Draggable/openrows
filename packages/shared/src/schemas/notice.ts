import { z } from 'zod';

/**
 * Service notices: what the operator tells every account (or every workspace owner) ahead
 * of a change, by email and as a dismissible banner in the app. The kinds follow the Terms'
 * commitments: Terms and privacy policy updates, price changes, plan (free limit) changes and
 * other essential service notices.
 */
export const NOTICE_KINDS = ['terms', 'privacy', 'price', 'plan', 'service'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** Who gets a notice: every account, or only the owners of a workspace (price changes). */
export const NOTICE_AUDIENCES = ['everyone', 'owners'] as const;
export type NoticeAudience = (typeof NOTICE_AUDIENCES)[number];

/**
 * The least notice per kind, in days between sending and the change taking effect: the Terms
 * promise 14 days for significant Terms changes and 30 for price changes; free plan limits get
 * "reasonable notice", which we read as 14 days. The notice command refuses less.
 */
export const NOTICE_MIN_DAYS: Record<NoticeKind, number> = {
  terms: 14,
  privacy: 0,
  price: 30,
  plan: 14,
  service: 0,
};

/** How long after a change takes effect its banner still shows (until dismissed). */
export const NOTICE_BANNER_DAYS_AFTER = 30;

export const NOTICE_TITLE_MAX = 120;
export const NOTICE_SUMMARY_MAX = 1000;

export const NoticeSchema = z.object({
  id: z.uuid(),
  kind: z.enum(NOTICE_KINDS),
  title: z.string(),
  /** Plain text, shown under the title (no Markdown or HTML). */
  summary: z.string(),
  /** The page with the details (e.g. https://openrows.io/terms). */
  url: z.url(),
  effectiveAt: z.iso.datetime({ offset: true }),
  publishedAt: z.iso.datetime({ offset: true }),
});
export type Notice = z.infer<typeof NoticeSchema>;

/** The notices the signed-in user hasn't dismissed, oldest change first. */
export const NoticeListSchema = z.object({ notices: z.array(NoticeSchema) });
export type NoticeList = z.infer<typeof NoticeListSchema>;

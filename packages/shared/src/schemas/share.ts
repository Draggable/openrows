import { z } from 'zod';
import { VIEW_TYPES, type ViewType } from '../constants/index.js';
import { MAX_DATE_RANGE_DAYS } from '../query/index.js';
import { fieldTypeNameSchema } from './field.js';
import {
  type CalendarDateFields,
  type CalendarLayout,
  calendarLayoutOf,
  calendarLayoutSchema,
  type GalleryLayout,
  galleryLayoutOf,
  galleryLayoutSchema,
  gridLayoutOf,
  gridLayoutSchema,
  isCalendarDateField,
  isSelfLinkField,
  type KanbanLayout,
  kanbanLayoutOf,
  kanbanLayoutSchema,
  type ListLayout,
  listLayoutOf,
  listLayoutSchema,
  pruneCalendarLayout,
  pruneGalleryLayout,
  pruneGridLayout,
  pruneKanbanLayout,
  pruneListLayout,
  pruneTimelineLayout,
  type TimelineLayout,
  timelineLayoutOf,
  timelineLayoutSchema,
} from './view.js';

/**
 * Share links: a view or a whole base published read-only at `/s/<token>` to anyone
 * with the link. The token is 32 random bytes (base64url, 43 characters), shown once when the
 * link is made; the server stores only its SHA-256. A link stops working when it is revoked, when
 * it expires, when its view, table or base is deleted, or when the person who made it can no
 * longer share. A link may also ask for a password (argon2id) and/or a signed-in viewer
 * whose verified email is at one of a list of domains.
 */

/** A share token: 32 random bytes as base64url. */
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const shareTokenSchema = z.string().regex(SHARE_TOKEN_RE);

/** Most links one view (or one base, for base links) has at a time (revoked ones don't count). */
export const MAX_SHARES_PER_VIEW = 20;
/**
 * What a link shows: one view, every table and non-personal view of a base, or a form
 * view to fill in (`/f/<token>`).
 */
export const SHARE_KINDS = ['view', 'base', 'form'] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];
/** Password length bounds. */
export const SHARE_PASSWORD_MIN = 8;
export const SHARE_PASSWORD_MAX = 256;
/** Most email domains one link may allow. */
export const MAX_SHARE_DOMAINS = 20;
/** Most origins one link may be embedded on. */
export const MAX_SHARE_EMBED_ORIGINS = 20;
/** Most records a shared CSV download holds. */
export const SHARED_CSV_MAX_RECORDS = 50_000;

/**
 * An email domain a link allows: lower case, no `@`, no wildcard. A viewer's address
 * matches only when the part after its last `@` is exactly this domain (`example.com` doesn't
 * admit `evil-example.com` or `mail.example.com`).
 */
export const shareDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/,
    'Enter a domain such as example.com.'
  )
  .refine((d) => !/^\d+$/.test(d.slice(d.lastIndexOf('.') + 1)), 'Enter a domain name.');

/** The domain of an email address (after its last `@`), lower case; `null` without one. */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

/** Whether a verified address is at one of the allowed domains (exact match). */
export function emailDomainAllowed(
  user: { email: string | null; emailVerified: boolean } | null | undefined,
  domains: readonly string[]
): boolean {
  if (!user?.emailVerified) return false;
  const domain = emailDomain(user.email);
  return domain !== null && domains.includes(domain);
}

/**
 * An origin a link may be embedded on (`/embed/<token>` in an iframe): `https://` and a
 * domain name, with an optional port, nothing else (no path, query, credentials, wildcard or IP
 * address). Normalized to its serialized origin (`https://Example.com/` is
 * `https://example.com`), which is what `Content-Security-Policy: frame-ancestors` lists, so a
 * value can never smuggle another directive or source into the header.
 */
export const shareEmbedOriginSchema = z
  .string()
  .trim()
  .max(300)
  .transform((value, ctx) => {
    const origin = embedOriginOf(value);
    if (origin === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'Enter an https origin such as https://example.com.',
      });
      return z.NEVER;
    }
    return origin;
  });

/** The serialized origin of an https URL of a domain with no path, query or credentials. */
function embedOriginOf(value: string): string | null {
  if (!/^https:\/\/[^/?#]+\/?$/i.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (!shareDomainSchema.safeParse(url.hostname).success) return null;
  return url.origin;
}

/**
 * The origins that may frame a link's `/embed/<token>` page: its embed origins, unless it
 * has a password or email domains and its maker didn't allow embedding it anyway (a password
 * form or a sign-in inside someone else's page is a phishing pattern, and browsers that block
 * third-party cookies can't keep the unlock or the session in a frame). Empty: no framing.
 */
export function shareFrameAncestors(share: {
  embedOrigins: readonly string[];
  allowRestrictedEmbed: boolean;
  hasPassword: boolean;
  allowedDomains: readonly string[];
}): string[] {
  const restricted = share.hasPassword || share.allowedDomains.length > 0;
  return restricted && !share.allowRestrictedEmbed ? [] : [...share.embedOrigins];
}

const sharePasswordSchema = z.string().min(SHARE_PASSWORD_MIN).max(SHARE_PASSWORD_MAX);
const shareDomainsSchema = z
  .array(shareDomainSchema)
  .max(MAX_SHARE_DOMAINS)
  .transform((list) => [...new Set(list)]);
const shareEmbedOriginsSchema = z
  .array(shareEmbedOriginSchema)
  .max(MAX_SHARE_EMBED_ORIGINS)
  .transform((list) => [...new Set(list)]);
/**
 * View types a share link can show (a form view's
 * link is its public form).
 */
export const SHAREABLE_VIEW_TYPES = [
  'grid',
  'kanban',
  'calendar',
  'gallery',
  'timeline',
  'list',
] as const satisfies readonly ViewType[];
/**
 * Most records the public kanban, calendar, gallery, timeline and list pages load: they
 * lay out every record they show at once (calendars and timelines per date window).
 */
export const SHARED_LAYOUT_MAX_RECORDS = 1000;
/** Largest page of `GET /api/shared/:shareToken/records`. */
export const SHARED_PAGE_MAX = 200;
/** The furthest a link's expiry may be set. */
export const MAX_SHARE_LIFETIME_DAYS = 3660;

/**
 * `POST /api/views/:viewId/shares` and `POST /api/bases/:baseId/shares`: a new link, optionally
 * expiring (in the future), with a password, allowed email domains and the copy/download
 * toggles (copying allowed and CSV download off by default), and the origins it may be embedded
 * on.
 */
export const createShareSchema = z
  .object({
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
    password: sharePasswordSchema.nullable().optional(),
    allowedDomains: shareDomainsSchema.optional(),
    allowCopy: z.boolean().optional(),
    allowDownload: z.boolean().optional(),
    embedOrigins: shareEmbedOriginsSchema.optional(),
    allowRestrictedEmbed: z.boolean().optional(),
  })
  .strict();

/**
 * `PATCH .../shares/:shareId`: change a link's settings. A new `password` replaces the old one and
 * signs out everyone who entered it; `null` removes it.
 */
export const updateShareSchema = createShareSchema;

/** A share link as its sharers see it (the token and the password are never shown again). */
export const ShareSchema = z.object({
  id: z.uuid(),
  kind: z.enum(SHARE_KINDS),
  /** The shared view (kind `view`), else null. */
  viewId: z.uuid().nullable(),
  baseId: z.uuid(),
  createdBy: z.uuid().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  /** Past its expiry (expired links are listed until revoked, so they can be cleaned up). */
  expired: z.boolean(),
  hasPassword: z.boolean(),
  allowedDomains: z.array(z.string()),
  allowCopy: z.boolean(),
  allowDownload: z.boolean(),
  /** Sites that may show the link in an iframe (`/embed/<token>`); empty: none. */
  embedOrigins: z.array(z.string()),
  /** A link with a password or domains may be embedded too (by default it may not). */
  allowRestrictedEmbed: z.boolean(),
});

/** A new link: the token, shown once. The page is `/s/<token>`. */
export const CreatedShareSchema = z.object({ share: ShareSchema, token: shareTokenSchema });

export const ShareListSchema = z.object({ shares: z.array(ShareSchema) });

/**
 * A field as a share link shows it: no table id, permissions, description or timestamps, and
 * only the options needed to display values (`publicFieldOptions`).
 */
export const SharedFieldSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  type: fieldTypeNameSchema,
  options: z.unknown(),
  isPrimary: z.boolean(),
});

/** `POST /api/shared/:shareToken/unlock`: the link's password. */
export const unlockShareSchema = z
  .object({
    password: z.string().min(1).max(SHARE_PASSWORD_MAX),
    /**
     * A Turnstile token: required when the server has Turnstile keys, whose site key the
     * SHARE_PASSWORD_REQUIRED problem names (`captchaSiteKey`).
     */
    captchaToken: z.string().min(1).max(2048).optional(),
  })
  .strict();

/**
 * `GET /api/shared/:shareToken`: what a link shows, once its password and domain checks pass:
 * its name (the view's, or the base's), the views it opens (one, or every table's shareable
 * non-personal views of a base, in sidebar order) and what viewers may do.
 */
export const SharedShareSchema = z.object({
  kind: z.enum(SHARE_KINDS),
  name: z.string(),
  tables: z.array(
    z.object({
      name: z.string(),
      views: z.array(z.object({ id: z.uuid(), name: z.string(), type: z.enum(VIEW_TYPES) })),
    })
  ),
  allowCopy: z.boolean(),
  allowDownload: z.boolean(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
});

/**
 * `GET /api/shared/:shareToken/views/:viewId`: what the public page needs to draw the view. Only
 * the visible fields are listed, and the layout names nothing else (no hidden field ids, no
 * filter).
 */
export const SharedViewSchema = z.object({
  view: z.object({ name: z.string(), type: z.enum(VIEW_TYPES) }),
  table: z.object({ name: z.string() }),
  fields: z.array(SharedFieldSchema),
  layout: gridLayoutSchema.omit({ hiddenFields: true }),
  /**
   * The layout of a kanban, calendar, gallery, timeline or list view, naming only the
   * fields the view shows; card and row fields are resolved (never left to a default).
   */
  kanban: kanbanLayoutSchema.optional(),
  calendar: calendarLayoutSchema.optional(),
  gallery: galleryLayoutSchema.optional(),
  timeline: timelineLayoutSchema.optional(),
  list: listLayoutSchema.optional(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
});

/**
 * `GET /api/shared/:shareToken/views/:viewId/records`: a window of the view's records. Nothing else is
 * accepted (strict), so the view's filter, sorts and fields can't be replaced.
 */
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;

export const sharedRecordsQuerySchema = z
  .object({
    offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
    limit: z.coerce.number().int().min(1).max(SHARED_PAGE_MAX).default(100),
    /**
     * A calendar's or timeline's date window, both or neither: only records whose dates
     * (the view's own date fields, chosen by the server) overlap it. It only narrows the view.
     */
    from: isoDay.optional(),
    to: isoDay.optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    if ((q.from === undefined) !== (q.to === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'Give both from and to, or neither.' });
    } else if (q.from !== undefined && q.to !== undefined) {
      const span = dayNumber(q.to) - dayNumber(q.from);
      if (!(span >= 0 && span <= MAX_DATE_RANGE_DAYS)) {
        ctx.addIssue({
          code: 'custom',
          path: ['to'],
          message: `The window must run forward and span at most ${MAX_DATE_RANGE_DAYS} days.`,
        });
      }
    }
  });

/**
 * A record as a share link shows it: its id (the page's row key) and the visible fields. Link
 * cells are the linked records' names, people cells the people's names, attachments their
 * metadata (files download through the link, `downloads.sharedAttachment`).
 */
export const SharedRecordSchema = z.object({
  id: z.uuid(),
  fields: z.record(z.string(), z.unknown()),
  /**
   * The structure of a timeline's dependencies or a list's parents: per such self-link
   * field, the ids of the linked records the view also shows (never one it filters out).
   */
  links: z.record(z.string(), z.array(z.uuid())).optional(),
});

export const SharedRecordsSchema = z.object({
  records: z.array(SharedRecordSchema),
  offset: z.int(),
  total: z.int(),
});

export type CreateShareInput = z.infer<typeof createShareSchema>;
export type UpdateShareInput = z.infer<typeof updateShareSchema>;
export type SharedShare = z.infer<typeof SharedShareSchema>;
export type Share = z.infer<typeof ShareSchema>;
export type CreatedShare = z.infer<typeof CreatedShareSchema>;
export type SharedField = z.infer<typeof SharedFieldSchema>;
export type SharedView = z.infer<typeof SharedViewSchema>;
export type SharedRecord = z.infer<typeof SharedRecordSchema>;
export type SharedRecordsQuery = z.input<typeof sharedRecordsQuerySchema>;

/** A field as `sharedViewShape` needs it: the table's live fields, in table order. */
export interface ShapeField {
  id: string;
  type: string;
  isPrimary: boolean;
  options?: unknown;
}

/**
 * What a shared view shows, from its stored config: the fields whose values leave
 * (`fieldIds`), the self-link fields whose structure leaves as ids of shown records (`links`:
 * a timeline's dependencies, a list's parents), the date fields a date window applies to, and the
 * layout of its type naming nothing else. A grid shows what it doesn't hide; a kanban, gallery or
 * list its title, card or row fields (the saved ones, else the first three, as the app does),
 * stack and cover; a calendar or timeline its title and date, group and colour fields.
 */
export interface SharedViewShape {
  fieldIds: string[];
  links: string[];
  dateFields: CalendarDateFields[];
  kanban?: KanbanLayout;
  calendar?: CalendarLayout;
  gallery?: GalleryLayout;
  timeline?: TimelineLayout;
  list?: ListLayout;
}

/** The saved card/row fields that are live and not the primary, else the first three others. */
function cardsOf(
  fields: readonly ShapeField[],
  saved: readonly string[] | undefined,
  skip: (string | null | undefined)[]
): string[] {
  const live = fields.filter((f) => !f.isPrimary);
  if (saved) return saved.filter((id) => live.some((f) => f.id === id));
  return live
    .filter((f) => !skip.includes(f.id))
    .slice(0, 3)
    .map((f) => f.id);
}

export function sharedViewShape(
  view: { type: string; config: unknown },
  fields: readonly ShapeField[],
  tableId: string
): SharedViewShape {
  const config = (view.config ?? {}) as Record<string, unknown>;
  const primary = fields.filter((f) => f.isPrimary).map((f) => f.id);
  const byId = new Map(fields.map((f) => [f.id, f]));
  const known = (ids: (string | null | undefined)[]) =>
    ids.filter((id): id is string => typeof id === 'string' && byId.has(id));
  const unique = (ids: string[]) => [...new Set(ids)];
  switch (view.type) {
    case 'kanban': {
      const l = pruneKanbanLayout(kanbanLayoutOf(config), fields);
      const stackFieldId = l.stackFieldId ?? null;
      const cardFields = cardsOf(fields, l.cardFields, [stackFieldId]);
      const coverFieldId = l.coverFieldId ?? null;
      return {
        fieldIds: unique([...primary, ...known([stackFieldId, coverFieldId]), ...cardFields]),
        links: [],
        dateFields: [],
        kanban: {
          stackFieldId,
          cardFields,
          coverFieldId,
          ...(l.collapseEmpty !== undefined ? { collapseEmpty: l.collapseEmpty } : {}),
        },
      };
    }
    case 'gallery': {
      const l = pruneGalleryLayout(galleryLayoutOf(config), fields);
      const coverFieldId = l.coverFieldId ?? null;
      const cardFields = cardsOf(fields, l.cardFields, [coverFieldId]);
      return {
        fieldIds: unique([...primary, ...known([coverFieldId]), ...cardFields]),
        links: [],
        dateFields: [],
        gallery: { ...l, coverFieldId, cardFields },
      };
    }
    case 'list': {
      const l = pruneListLayout(listLayoutOf(config), fields);
      const parent = l.parentFieldId ? byId.get(l.parentFieldId) : undefined;
      const parentFieldId = parent && isSelfLinkField(parent, tableId) ? parent.id : null;
      const rowFields = cardsOf(fields, l.rowFields, [parentFieldId]);
      return {
        fieldIds: unique([...primary, ...rowFields]),
        links: known([parentFieldId]),
        dateFields: [],
        list: { parentFieldId, rowFields },
      };
    }
    case 'calendar': {
      const l = pruneCalendarLayout(calendarLayoutOf(config), fields);
      const dateFields = (l.dateFields ?? []).filter((d) =>
        isCalendarDateField(byId.get(d.startFieldId) ?? { type: '' })
      );
      const colorFieldId = l.colorFieldId ?? null;
      return {
        fieldIds: unique([
          ...primary,
          ...known(dateFields.flatMap((d) => [d.startFieldId, d.endFieldId])),
          ...known([colorFieldId]),
        ]),
        links: [],
        dateFields,
        calendar: { ...l, dateFields, colorFieldId },
      };
    }
    case 'timeline': {
      const l = pruneTimelineLayout(timelineLayoutOf(config), fields);
      const dependency = l.dependencyFieldId ? byId.get(l.dependencyFieldId) : undefined;
      const dependencyFieldId =
        dependency && isSelfLinkField(dependency, tableId) ? dependency.id : null;
      const timeline: TimelineLayout = { ...l, dependencyFieldId };
      return {
        fieldIds: unique([
          ...primary,
          ...known([l.startFieldId, l.endFieldId, l.groupFieldId, l.colorFieldId]),
        ]),
        links: known([dependencyFieldId]),
        dateFields: l.startFieldId
          ? [{ startFieldId: l.startFieldId, endFieldId: l.endFieldId ?? null }]
          : [],
        timeline,
      };
    }
    default: {
      const layout = pruneGridLayout(gridLayoutOf(config), fields);
      const hidden = new Set(layout.hiddenFields ?? []);
      return {
        fieldIds: fields.filter((f) => !hidden.has(f.id)).map((f) => f.id),
        links: [],
        dateFields: [],
      };
    }
  }
}

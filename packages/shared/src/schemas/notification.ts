import { z } from 'zod';

/**
 * Notifications: one row per recipient, created when someone mentions you in a comment
 * (`mention`), replies on a record you commented on (`reply`), or adds you to a user field that
 * notifies (`assigned`). The inbox shows only notifications whose record you can still read;
 * names and the excerpt are read when listed, never stored.
 */
export const NOTIFICATION_KINDS = ['mention', 'reply', 'assigned'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Which notifications are emailed: all, only mentions, or none (the in-app inbox gets all). */
export const NOTIFICATION_EMAIL_PREFERENCES = ['all', 'mentions', 'none'] as const;
export type NotificationEmailPreference = (typeof NOTIFICATION_EMAIL_PREFERENCES)[number];

/**
 * When notification emails go out: `immediately` (one email per record, coalesced over 10
 * minutes), or one `hourly` or `daily` digest with everything since the last one.
 */
export const NOTIFICATION_EMAIL_FREQUENCIES = ['immediately', 'hourly', 'daily'] as const;
export type NotificationEmailFrequency = (typeof NOTIFICATION_EMAIL_FREQUENCIES)[number];

/** The hour (UTC) daily digests go out. */
export const DAILY_DIGEST_HOUR_UTC = 8;

/** Notifications per inbox page: the default and the cap. */
export const NOTIFICATIONS_PAGE_DEFAULT = 30;
export const NOTIFICATIONS_PAGE_MAX = 100;

export const NotificationSchema = z.object({
  id: z.uuid(),
  kind: z.enum(NOTIFICATION_KINDS),
  /** Who caused it; null once their account is gone. */
  actorId: z.uuid().nullable(),
  /** Their display name (never an email); 'Someone' once their account is gone. */
  actorName: z.string(),
  workspaceId: z.uuid(),
  baseId: z.uuid(),
  tableId: z.uuid(),
  recordId: z.uuid(),
  /** The comment (mentions and replies). */
  commentId: z.uuid().nullable(),
  /** The user field (assignments). */
  fieldId: z.uuid().nullable(),
  baseName: z.string(),
  tableName: z.string(),
  /** The record's primary field as text ('' when empty). */
  recordName: z.string(),
  fieldName: z.string().nullable(),
  /** The comment as one line of plain text, up to 200 characters; null when it was deleted. */
  excerpt: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  readAt: z.iso.datetime({ offset: true }).nullable(),
});
export type Notification = z.infer<typeof NotificationSchema>;

/** `GET /api/notifications`: newest first. */
export const listNotificationsQuerySchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(NOTIFICATIONS_PAGE_MAX)
    .default(NOTIFICATIONS_PAGE_DEFAULT),
  /** The opaque `nextCursor` of the previous page. */
  cursor: z.string().max(200).optional(),
  /** Only unread ones. */
  unread: z.enum(['true', 'false']).optional(),
});
export type ListNotificationsQuery = z.input<typeof listNotificationsQuerySchema>;

export const NotificationListSchema = z.object({
  notifications: z.array(NotificationSchema),
  nextCursor: z.string().nullable(),
  /** Unread notifications in total (the bell's count). */
  unread: z.int().nonnegative(),
});
export type NotificationList = z.infer<typeof NotificationListSchema>;

export const UnreadNotificationsSchema = z.object({ unread: z.int().nonnegative() });
export type UnreadNotifications = z.infer<typeof UnreadNotificationsSchema>;

/** `GET /api/me/notification-preferences`. */
export const NotificationPreferencesSchema = z.strictObject({
  email: z.enum(NOTIFICATION_EMAIL_PREFERENCES),
  frequency: z.enum(NOTIFICATION_EMAIL_FREQUENCIES),
});
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

/** `PUT /api/me/notification-preferences`: either or both. */
export const UpdateNotificationPreferencesSchema = z
  .strictObject({
    email: z.enum(NOTIFICATION_EMAIL_PREFERENCES).optional(),
    frequency: z.enum(NOTIFICATION_EMAIL_FREQUENCIES).optional(),
  })
  .refine((v) => v.email !== undefined || v.frequency !== undefined, 'Nothing to change.');
export type UpdateNotificationPreferences = z.infer<typeof UpdateNotificationPreferencesSchema>;

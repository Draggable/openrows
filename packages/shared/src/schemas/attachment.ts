import { z } from 'zod';
import { attachmentValueSchema } from '../fields/types/attachment.js';

/** The largest file an attachment cell takes. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** How long a presigned upload or download URL stays valid. */
export const ATTACHMENT_UPLOAD_TTL_SECONDS = 15 * 60;
/** Signed per 5-minute window, so a download URL is good for 5 to 10 minutes. */
export const ATTACHMENT_DOWNLOAD_TTL_SECONDS = 10 * 60;

/**
 * Image types the browser may show inline (and the thumbnail job reads). Everything else,
 * SVG and HTML included, downloads with `Content-Disposition: attachment`.
 */
export const INLINE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export function isInlineImageType(type: string): boolean {
  return (INLINE_IMAGE_TYPES as readonly string[]).includes(type.toLowerCase());
}

/** A MIME type the server stores and signs (`type/subtype`, no parameters). */
export const mimeTypeSchema = z
  .string()
  .max(255)
  .regex(/^[\w.+-]+\/[\w.+-]+$/, 'Not a MIME type.')
  .transform((t) => t.toLowerCase());

/** The largest cover or logo image of a form. */
export const MAX_FORM_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * `POST /api/tables/:tableId/attachments`: announce a file for an attachment field of the
 * table, or (`viewId`) a cover or logo image of one of its form views (a PNG, JPEG, GIF
 * or WebP up to 10 MB). The server picks the storage key and answers a presigned PUT for
 * exactly this size and type.
 */
export const createAttachmentSchema = z
  .object({
    fieldId: z.uuid().optional(),
    viewId: z.uuid().optional(),
    filename: z.string().trim().min(1).max(255),
    /** The browser's type; empty or unknown becomes `application/octet-stream`. */
    type: z.union([mimeTypeSchema, z.literal('')]).default(''),
    size: z.int().min(1).max(MAX_ATTACHMENT_BYTES),
  })
  .strict()
  .refine((a) => (a.fieldId === undefined) !== (a.viewId === undefined), {
    message: 'Name either a field or a form view.',
    path: ['fieldId'],
  })
  .refine((a) => a.viewId === undefined || isInlineImageType(a.type), {
    message: 'A form image is a PNG, JPEG, GIF or WebP file.',
    path: ['type'],
  })
  .refine((a) => a.viewId === undefined || a.size <= MAX_FORM_IMAGE_BYTES, {
    message: 'A form image is at most 10 MB.',
    path: ['size'],
  });

export type CreateAttachmentInput = z.input<typeof createAttachmentSchema>;

/** Where and how to PUT the bytes: send exactly these headers, before `expiresAt`. */
export const AttachmentUploadSchema = z.object({
  attachment: attachmentValueSchema,
  upload: z.object({
    method: z.literal('PUT'),
    url: z.url(),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.iso.datetime(),
  }),
});

export type AttachmentUpload = z.infer<typeof AttachmentUploadSchema>;

/** A workspace's stored bytes (the M5 quotas read it): confirmed files and thumbnails. */
export const StorageUsageSchema = z.object({
  workspaceId: z.uuid(),
  files: z.number().int(),
  bytes: z.number().int(),
});

export type StorageUsage = z.infer<typeof StorageUsageSchema>;

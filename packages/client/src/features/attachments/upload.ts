import {
  type AttachmentValue,
  downloads,
  isInlineImageType,
  MAX_ATTACHMENT_BYTES,
  MAX_FORM_IMAGE_BYTES,
} from '@openrows/shared';
import { api, downloadUrl, putToStorage } from '../../api/client';

/**
 * Uploading files into an attachment cell: announce each file, PUT it to the presigned
 * URL, confirm it. The caller then writes the values into the cell like any edit.
 */

/** The file's download link (the server redirects to a short-lived signed URL). */
export const fileUrl = (tableId: string, attachmentId: string) =>
  downloadUrl(downloads.attachment, { params: { tableId, attachmentId } });

/** The image's thumbnail (or the image while the thumbnail is being made). */
export const thumbnailUrl = (tableId: string, attachmentId: string) =>
  downloadUrl(downloads.attachmentThumbnail, { params: { tableId, attachmentId } });

/** Why a file can't be uploaded before trying, or null. */
export function uploadProblem(file: { name: string; size: number }): string | null {
  if (file.size === 0) return `"${file.name}" is empty.`;
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `"${file.name}" is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`;
  }
  return null;
}

/** The browser's MIME type when it is a plain `type/subtype`, else empty (octet-stream). */
const mimeOf = (file: File) => (/^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : '');

export async function uploadFile(
  tableId: string,
  fieldId: string,
  file: File
): Promise<AttachmentValue> {
  const problem = uploadProblem(file);
  if (problem) throw new Error(problem);
  const { attachment, upload } = await api.attachments.create({
    params: { tableId },
    body: { fieldId, filename: file.name, type: mimeOf(file), size: file.size },
  });
  await putToStorage(upload, file);
  return api.attachments.confirm({ params: { tableId, attachmentId: attachment.id } });
}

/** Uploads a form's cover or logo image: a PNG, JPEG, GIF or WebP up to 10 MB. */
export async function uploadFormImage(
  tableId: string,
  viewId: string,
  file: File
): Promise<AttachmentValue> {
  if (!isInlineImageType(file.type)) throw new Error('Pick a PNG, JPEG, GIF or WebP image.');
  if (file.size === 0 || file.size > MAX_FORM_IMAGE_BYTES) {
    throw new Error(`An image of at most ${MAX_FORM_IMAGE_BYTES / 1024 / 1024} MB.`);
  }
  const { attachment, upload } = await api.attachments.create({
    params: { tableId },
    body: { viewId, filename: file.name, type: file.type, size: file.size },
  });
  await putToStorage(upload, file);
  return api.attachments.confirm({ params: { tableId, attachmentId: attachment.id } });
}

/** Uploads the files one after another; the uploaded ones and the first failure, if any. */
export async function uploadFiles(
  tableId: string,
  fieldId: string,
  files: File[]
): Promise<{ uploaded: AttachmentValue[]; error?: unknown }> {
  const uploaded: AttachmentValue[] = [];
  for (const file of files) {
    try {
      uploaded.push(await uploadFile(tableId, fieldId, file));
    } catch (error) {
      return { uploaded, error };
    }
  }
  return { uploaded };
}

/** Files of a drag event, if it carries any. */
export const dragHasFiles = (e: { dataTransfer: DataTransfer | null }) =>
  e.dataTransfer?.types.includes('Files') ?? false;

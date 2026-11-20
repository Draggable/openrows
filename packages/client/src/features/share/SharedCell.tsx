import {
  type AttachmentValue,
  downloads,
  type FieldMeta,
  getFieldType,
  isInlineImageType,
  type SharedField,
} from '@openrows/shared';
import { downloadUrl } from '../../api/client';
import { cn } from '../../lib/utils';
import { CellContent, fileIcon, LinkChip } from '../grid/cells/CellContent';

/** The registry's view of a shared field, for the cell renderers (they read type and options). */
export function asFieldMeta(field: SharedField): FieldMeta {
  return {
    ...field,
    tableId: '',
    description: null,
    position: 0,
    createdAt: '',
    updatedAt: '',
    deletedAt: null,
  };
}

/**
 * Where a shared cell's files download from (each URL checked by the server on every request):
 * a share link's view, or an interface page.
 */
export interface FileLinks {
  file: (attachmentId: string) => string;
  thumbnail: (attachmentId: string) => string;
}

/** The files of a share link's view. */
export function shareFileLinks(token: string, viewId: string): FileLinks {
  const params = (attachmentId: string) => ({ shareToken: token, viewId, attachmentId });
  return {
    file: (id) => downloadUrl(downloads.sharedAttachment, { params: params(id) }),
    thumbnail: (id) => downloadUrl(downloads.sharedAttachmentThumbnail, { params: params(id) }),
  };
}

/** The files an interface page shows (`draft`: the saved draft's, for its creators). */
export function interfaceFileLinks(interfaceId: string, pageId: string, draft = false): FileLinks {
  const input = (attachmentId: string) => ({
    params: { interfaceId, pageId, attachmentId },
    query: draft ? { draft: 'true' } : {},
  });
  return {
    file: (id) => downloadUrl(downloads.interfaceAttachment, input(id)),
    thumbnail: (id) => downloadUrl(downloads.interfaceAttachmentThumbnail, input(id)),
  };
}

/**
 * A shared cell: links and people arrive as names (the server leaves out their ids), files
 * download through the link or page they're shown on; everything else draws like the grid's cells.
 */
export function SharedCell({
  files,
  field,
  value,
}: {
  /** Where files download from; null: file names only. */
  files: FileLinks | null;
  field: FieldMeta;
  value: unknown;
}) {
  if (value === null) return null;
  const def = getFieldType(field.type);
  if (def.editor.kind === 'link' || def.category === 'people') {
    const names = Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
    return (
      <span className="flex min-w-0 gap-1 overflow-hidden">
        {names.map((name, i) => (
          // Names repeat; their place in the cell is their identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: names only, no ids
          <LinkChip key={i} name={name} />
        ))}
      </span>
    );
  }
  if (def.editor.kind === 'attachment') {
    const items = (Array.isArray(value) ? value : []) as AttachmentValue[];
    return (
      <span className="flex min-w-0 items-center gap-1">
        {items.slice(0, 3).map((f) =>
          files === null ? (
            <span key={f.id} className="truncate text-small text-text-2">
              {f.filename}
            </span>
          ) : (
            <SharedFile key={f.id} files={files} file={f} />
          )
        )}
        {items.length > 3 && <span className="text-small text-text-2">+{items.length - 3}</span>}
      </span>
    );
  }
  return <CellContent field={field} value={value} />;
}

export function SharedFile({ files, file }: { files: FileLinks; file: AttachmentValue }) {
  const href = files.file(file.id);
  const tile = 'size-7 shrink-0 rounded-xs border border-border bg-header';
  const Icon = fileIcon(file.type);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={file.filename}
      aria-label={file.filename}
    >
      {isInlineImageType(file.type) ? (
        <img
          src={files.thumbnail(file.id)}
          alt=""
          loading="lazy"
          className={cn(tile, 'object-cover')}
        />
      ) : (
        <span className={cn(tile, 'flex items-center justify-center text-text-2')}>
          <Icon aria-hidden className="size-3.5" />
        </span>
      )}
    </a>
  );
}

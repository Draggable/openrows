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
 * A shared cell: links and people arrive as names (the server leaves out their ids), files
 * download through the link; everything else draws like the grid's cells.
 */
export function SharedCell({
  token,
  viewId,
  field,
  value,
}: {
  /** The link's token for file downloads; null (interface pages): file names only. */
  token: string | null;
  viewId: string;
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
    const files = (Array.isArray(value) ? value : []) as AttachmentValue[];
    return (
      <span className="flex min-w-0 items-center gap-1">
        {files.slice(0, 3).map((f) =>
          token === null ? (
            <span key={f.id} className="truncate text-small text-text-2">
              {f.filename}
            </span>
          ) : (
            <SharedFile key={f.id} token={token} viewId={viewId} file={f} />
          )
        )}
        {files.length > 3 && <span className="text-small text-text-2">+{files.length - 3}</span>}
      </span>
    );
  }
  return <CellContent field={field} value={value} />;
}

export function SharedFile({
  token,
  viewId,
  file,
}: {
  token: string;
  viewId: string;
  file: AttachmentValue;
}) {
  const params = { shareToken: token, viewId, attachmentId: file.id };
  const href = downloadUrl(downloads.sharedAttachment, { params });
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
          src={downloadUrl(downloads.sharedAttachmentThumbnail, { params })}
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

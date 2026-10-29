import {
  type AttachmentValue,
  type BarcodeType,
  type Choice,
  type ChoiceColor,
  type EditorKind,
  type FieldMeta,
  getFieldType,
  isInlineImageType,
  markdownToPlain,
} from '@openrows/shared';
import {
  Check,
  Circle,
  ExternalLink,
  File,
  FileImage,
  FileText,
  Flag,
  Heart,
  type LucideIcon,
  Play,
  Star,
  ThumbsUp,
} from 'lucide-react';
import { type CSSProperties, type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, api } from '../../../api/client';
import { cn } from '../../../lib/utils';
import { AiCell } from '../../ai-fields/AiCell';
import { thumbnailUrl } from '../../attachments/upload';
import { UserCell } from '../../collaborators/UserChip';
import {
  BARCODE_TYPE_LABELS,
  cellText,
  choicesOf,
  fieldDef,
  linkItems,
  selectedIds,
} from './model';

/** Inline styles of a choice chip in a palette colour (CSS variables, so dark mode follows). */
export function chipStyle(color: ChoiceColor): CSSProperties {
  return { background: `var(--chip-${color}-bg)`, color: `var(--chip-${color}-text)` };
}

/** A select chip: tint background, dot in the solid colour, label (never colour alone). */
export function ChoiceChip({ choice, children }: { choice: Choice; children?: ReactNode }) {
  return (
    <span
      data-color={choice.color}
      className="inline-flex h-5 max-w-full shrink-0 items-center gap-1.5 rounded-full px-2 text-small"
      style={chipStyle(choice.color)}
    >
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: `var(--chip-${choice.color})` }}
      />
      <span className="truncate">{choice.name}</span>
      {children}
    </span>
  );
}

/**
 * A linked record: a neutral tag with the record's primary text (mockup a-grid, b-record).
 * `children` holds actions (remove), `onOpen` makes the name a button that opens the record.
 */
export function LinkChip({
  name,
  onOpen,
  children,
}: {
  name: string;
  onOpen?: () => void;
  children?: ReactNode;
}) {
  const label = name || 'Unnamed record';
  return (
    <span
      data-link-chip
      className="inline-flex h-5 max-w-full shrink-0 items-center gap-1 rounded-xs bg-hover px-1.5 text-small text-text"
    >
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="truncate rounded-xs hover:underline focus-visible:outline-2 focus-visible:outline-brand"
        >
          {label}
        </button>
      ) : (
        <span className={cn('truncate', !name && 'text-text-2')}>{label}</span>
      )}
      {children}
    </span>
  );
}

/** A link cell: one chip per linked record, in order. */
function LinkCell({ value }: { value: unknown }) {
  const items = linkItems(value);
  if (items.length === 0) return null;
  return (
    <span className="flex min-w-0 gap-1 overflow-hidden">
      {items.map((item) => (
        <LinkChip key={item.id} name={item.name} />
      ))}
    </span>
  );
}

const RATING_ICONS: Record<string, LucideIcon> = {
  check: Check,
  star: Star,
  heart: Heart,
  thumbsUp: ThumbsUp,
  flag: Flag,
  dot: Circle,
};

type RatingOptions = { max: number; icon: string; color: ChoiceColor };

function Rating({
  value,
  options,
  onChange,
}: {
  value: unknown;
  options: RatingOptions;
  onChange?: (value: number | null) => void;
}) {
  const current = typeof value === 'number' ? value : 0;
  const Icon = RATING_ICONS[options.icon] ?? Star;
  return (
    <span
      role="img"
      aria-label={`${current} out of ${options.max}`}
      className="inline-flex items-center gap-0.5"
    >
      {Array.from({ length: options.max }, (_, i) => {
        const n = i + 1;
        const filled = n <= current;
        const icon = (
          <Icon
            key="icon"
            aria-hidden
            className="size-3.5"
            strokeWidth={2}
            style={
              filled
                ? { color: `var(--chip-${options.color})`, fill: `var(--chip-${options.color})` }
                : undefined
            }
          />
        );
        const look = cn(
          'inline-flex text-border-strong',
          !filled && 'invisible group-hover:visible group-focus-within:visible'
        );
        return onChange ? (
          <button
            key={n}
            type="button"
            tabIndex={-1}
            aria-label={`Rate ${n}`}
            onClick={() => onChange(n === current ? null : n)}
            className={look}
          >
            {icon}
          </button>
        ) : (
          <span key={n} className={look}>
            {icon}
          </span>
        );
      })}
    </span>
  );
}

function Checkbox({ checked, onChange }: { checked: boolean; onChange?: (v: boolean) => void }) {
  const box = checked ? (
    <span className="inline-flex size-4 items-center justify-center rounded-xs bg-primary text-primary-foreground">
      <Check className="size-3" strokeWidth={3} aria-label="Checked" />
    </span>
  ) : (
    <span className="inline-block size-4 rounded-xs border border-border-strong" />
  );
  if (!onChange) return box;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={checked ? 'Uncheck' : 'Check'}
      onClick={() => onChange(!checked)}
      className="inline-flex"
    >
      {box}
    </button>
  );
}

/** The icon for a file's MIME type. */
export function fileIcon(type: string): LucideIcon {
  if (type.startsWith('image/')) return FileImage;
  if (type.startsWith('text/') || type === 'application/pdf') return FileText;
  return File;
}

const extension = (filename: string) => {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1, dot + 5).toUpperCase() : '';
};

/** One 28 px file tile: the image's thumbnail, or an icon and the extension. */
export function AttachmentTile({
  tableId,
  file,
  className,
}: {
  tableId: string;
  file: AttachmentValue;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (isInlineImageType(file.type) && !failed) {
    return (
      <img
        src={thumbnailUrl(tableId, file.id)}
        alt={file.filename}
        title={file.filename}
        loading="lazy"
        draggable={false}
        onError={() => setFailed(true)}
        className={cn(
          'size-7 shrink-0 rounded-xs border border-border bg-header object-cover',
          className
        )}
      />
    );
  }
  const Icon = fileIcon(file.type);
  return (
    <span
      title={file.filename}
      aria-label={file.filename}
      role="img"
      className={cn(
        'flex size-7 shrink-0 flex-col items-center justify-center rounded-xs border border-border bg-header text-text-2',
        className
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      <span className="text-[8px] leading-[10px] font-semibold">{extension(file.filename)}</span>
    </span>
  );
}

/** Attachment tiles: 28 px, at most 3, then "+n". */
function Attachments({ tableId, value }: { tableId: string; value: unknown }) {
  const files = (Array.isArray(value) ? value : []) as AttachmentValue[];
  if (files.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-1">
      {files.slice(0, 3).map((f) => (
        <AttachmentTile key={f.id} tableId={tableId} file={f} />
      ))}
      {files.length > 3 && <span className="text-small text-text-2">+{files.length - 3}</span>}
    </span>
  );
}

/**
 * A button cell: the label as a button that opens the computed URL in a new tab, with
 * `rel="noopener noreferrer"`. The value is only ever an http(s) URL (the registry drops the
 * rest); without one the button shows disabled.
 */
/** Where a button cell is: a click that runs automations names the table and record. */
export interface ButtonTarget {
  tableId: string;
  recordId: string;
}

/**
 * The target of a button field's cell outside the grid (the record view, kanban, gallery,
 * list): only button fields get one, so other cells render as they do without a record.
 */
export function buttonTarget(field: FieldMeta, recordId: string | undefined) {
  return field.type === 'button' && recordId ? { tableId: field.tableId, recordId } : undefined;
}

function ButtonCell({
  field,
  value,
  target,
}: {
  field: FieldMeta;
  value: unknown;
  target?: ButtonTarget | undefined;
}) {
  const options = fieldDef(field).options as { label?: string; action?: string };
  const label = options.label || 'Open';
  const href = cellText(field, value);
  const look =
    'inline-flex h-6 max-w-full items-center gap-1.5 rounded-sm border border-border bg-surface px-2 text-small font-medium';
  if (options.action === 'runAutomation') {
    return <RunButton look={look} label={label} fieldId={field.id} target={target} />;
  }
  if (!href) {
    return (
      <span aria-disabled className={cn(look, 'text-text-3')}>
        <span className="truncate">{label}</span>
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={href}
      data-testid="button-cell"
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className={cn(look, 'text-text hover:bg-hover')}
    >
      <span className="truncate">{label}</span>
      <ExternalLink aria-hidden className="size-3 shrink-0 text-text-2" />
    </a>
  );
}

/**
 * A button that runs the base's automations for this record. The server checks the
 * clicker may edit the record; the runs happen in the background, in the automation's history.
 */
function RunButton({
  look,
  label,
  fieldId,
  target,
}: {
  look: string;
  label: string;
  fieldId: string;
  target?: ButtonTarget | undefined;
}) {
  const [busy, setBusy] = useState(false);
  if (!target) {
    return (
      <span aria-disabled className={cn(look, 'text-text-3')}>
        <span className="truncate">{label}</span>
      </span>
    );
  }
  const run = async () => {
    setBusy(true);
    try {
      const { started } = await api.automations.clickButton({
        params: { tableId: target.tableId, recordId: target.recordId, fieldId },
      });
      if (started > 0)
        toast.success(started === 1 ? 'Automation started' : `${started} automations started`);
      else toast.message('No automation is turned on for this button');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't run the automation");
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      data-testid="button-cell"
      disabled={busy}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      // Enter or Space on the button isn't the card's or row's Enter (open the record).
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        void run();
      }}
      className={cn(look, 'text-text hover:bg-hover disabled:text-text-3')}
    >
      <span className="truncate">{label}</span>
      <Play aria-hidden className="size-3 shrink-0 text-text-2" />
    </button>
  );
}

/** A barcode cell: the code in monospace, its symbology after it. */
function BarcodeCell({ value }: { value: unknown }) {
  const v = value as { text?: unknown; type?: unknown } | null;
  if (!v || typeof v.text !== 'string') return null;
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="truncate font-mono text-[12px]">{v.text}</span>
      {typeof v.type === 'string' && (
        <span className="shrink-0 text-small text-text-3">
          {BARCODE_TYPE_LABELS[v.type as BarcodeType] ?? v.type}
        </span>
      )}
    </span>
  );
}

const LINK_HREF: Partial<Record<EditorKind, (text: string) => string | null>> = {
  url: (t) => (/^https?:\/\//i.test(t) ? t : null),
  email: (t) => `mailto:${t}`,
  phone: (t) => `tel:${t.replace(/[^\d+]/g, '')}`,
};

/**
 * A cell's display, by the registry's editor kind: chips for selects and people, a checkbox, rating icons,
 * attachment tiles, links for URL/email/phone, and the registry's `format` text for the rest.
 * `onChange` makes the checkbox and rating icons clickable (editors and up).
 */
export function CellContent({
  field,
  value,
  onChange,
  button,
}: {
  field: FieldMeta;
  value: unknown;
  onChange?: (value: unknown) => void;
  /** A button field that runs automations needs to know its record, an AI field too. */
  button?: ButtonTarget;
}) {
  const def = getFieldType(field.type);
  const kind = def.editor.kind;
  // An AI answer with its generation state, where the record is known (not share links).
  if (field.type === 'ai' && button) {
    return <AiCell field={field} value={value} recordId={button.recordId} />;
  }
  if (kind === 'link') return <LinkCell value={value} />;
  // People (createdBy, lastModifiedBy): chips from the collaborator directory.
  if (def.category === 'people') return <UserCell value={value} />;
  switch (kind) {
    case 'checkbox':
      return <Checkbox checked={value === true} onChange={onChange} />;
    case 'rating':
      return (
        <Rating
          value={value}
          options={fieldDef(field).options as RatingOptions}
          onChange={onChange}
        />
      );
    case 'singleSelect':
    case 'multipleSelect': {
      const choices = choicesOf(field);
      const picked = selectedIds(value).flatMap((id) => choices.find((c) => c.id === id) ?? []);
      return (
        <span className="flex min-w-0 gap-1 overflow-hidden">
          {picked.map((c) => (
            <ChoiceChip key={c.id} choice={c} />
          ))}
        </span>
      );
    }
    case 'attachment':
      return <Attachments tableId={field.tableId} value={value} />;
    case 'url':
    case 'email':
    case 'phone': {
      const text = cellText(field, value);
      const href = text ? LINK_HREF[kind]?.(text) : null;
      if (!href) return <span className="truncate">{text}</span>;
      return (
        <a
          href={href}
          target={kind === 'url' ? '_blank' : undefined}
          rel="noopener noreferrer"
          className="truncate text-text underline decoration-border-strong underline-offset-2 hover:decoration-text"
        >
          {text}
        </a>
      );
    }
    case 'button':
      return <ButtonCell field={field} value={value} target={button} />;
    case 'barcode':
      return <BarcodeCell value={value} />;
    case 'longText': {
      // Rich text shows its text without the Markdown marks.
      const rich = (fieldDef(field).options as { richText?: boolean }).richText === true;
      const text = cellText(field, value);
      return (
        <span className="truncate">
          {(rich ? markdownToPlain(text) : text).replace(/\s*\n\s*/g, ' ')}
        </span>
      );
    }
    default:
      return <span className="truncate">{cellText(field, value)}</span>;
  }
}

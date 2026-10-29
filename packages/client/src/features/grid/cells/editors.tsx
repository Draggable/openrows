import {
  type AttachmentValue,
  type Choice,
  type EditorKind,
  type FieldMeta,
  instantInZone,
  type LinkOptions,
  MAX_CHOICE_NAME,
  nextChoiceColor,
} from '@openrows/shared';
import { Check, Paperclip, Plus, X } from 'lucide-react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { type ReactNode, type SyntheticEvent, useEffect, useRef, useState } from 'react';
import { useLinkCandidates } from '../../../api/queries';
import { Button } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { dragHasFiles, fileUrl, uploadFiles } from '../../attachments/upload';
import { BarcodeEditor } from './BarcodeEditor';
import { AttachmentTile, ChoiceChip, LinkChip } from './CellContent';
import {
  cellText,
  choicesOf,
  coerceValue,
  fieldDef,
  INLINE_TEXT_EDITORS,
  invalidMessage,
  type LinkCellItem,
  linkItems,
  parseInput,
  selectedIds,
} from './model';
import { RichTextInput } from './RichText';
import { UserEditor } from './UserEditor';

/**
 * What an editor hands back: the new value, or why the input can't be saved. `typecast` says the
 * value names select options to create, so the write must send it.
 */
export type EditorResult = { value: unknown; typecast?: boolean } | { error: string };

/**
 * Where the selection goes after an edit: `stay` on the cell, `next`/`prev` (Tab/Shift+Tab), or
 * `away` (the user clicked elsewhere, which already moved the selection).
 */
export type EditorMove = 'stay' | 'next' | 'prev' | 'away';

export interface CellEditorProps {
  field: FieldMeta;
  value: unknown;
  /** The character typed to open the editor, if any. */
  initialText?: string;
  align: 'left' | 'right' | 'center';
  onCommit: (result: EditorResult, move: EditorMove) => void;
  onCancel: () => void;
  /** The select editors offer "+ Add option" (owners and creators). */
  canAddOptions?: boolean;
}

/** Editor kinds that open an editor (checkbox and rating are edited in place, see CellContent). */
export function opensEditor(kind: EditorKind): boolean {
  return kind !== 'none' && kind !== 'checkbox' && kind !== 'rating';
}

// Editor events bubble through React portals to the grid cell; keep them from re-selecting or
// re-opening the cell.
export const stop = (e: SyntheticEvent) => e.stopPropagation();

/** Guards against a second commit (Enter, then the blur of the unmounting input). */
export function useOnce() {
  const done = useRef(false);
  return (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };
}

export const tabMove = (e: { shiftKey: boolean }): EditorMove => (e.shiftKey ? 'prev' : 'next');

/** The editor for a cell, picked by the registry's editor kind. */
export function CellEditor(props: CellEditorProps) {
  const kind = fieldDef(props.field).def.editor.kind;
  if (INLINE_TEXT_EDITORS.has(kind)) return <TextEditor {...props} />;
  switch (kind) {
    case 'longText':
      return <LongTextEditor {...props} />;
    case 'singleSelect':
    case 'multipleSelect':
      return <SelectEditor {...props} multiple={kind === 'multipleSelect'} />;
    case 'date':
    case 'dateTime':
      return <DateEditor {...props} withTime={kind === 'dateTime'} />;
    case 'attachment':
      return <AttachmentEditor {...props} />;
    case 'link':
      return <LinkEditor {...props} />;
    case 'user':
      return <UserEditor {...props} />;
    case 'barcode':
      return <BarcodeEditor {...props} />;
    default:
      return null;
  }
}

/** Single-line text, number, duration, email, URL and phone: an input over the cell. */
function TextEditor({ field, value, initialText, align, onCommit, onCancel }: CellEditorProps) {
  const [draft, setDraft] = useState(initialText ?? cellText(field, value));
  const once = useOnce();
  const commit = (move: EditorMove) =>
    once(() => {
      const parsed = parseInput(field, draft);
      if (parsed === null && draft.trim() !== '') {
        onCommit({ error: invalidMessage(field, draft) }, move);
      } else onCommit({ value: parsed }, move);
    });
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: the editor opens on purpose
      autoFocus
      aria-label={field.name}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => commit('away')}
      onMouseDown={stop}
      onDoubleClick={stop}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commit('stay');
        } else if (e.key === 'Escape') {
          e.preventDefault();
          once(onCancel);
        } else if (e.key === 'Tab') {
          e.preventDefault();
          commit(tabMove(e));
        }
      }}
      className={cn(
        'absolute inset-0 h-full w-full bg-surface px-2 outline-2 -outline-offset-2 outline-primary',
        align === 'right' && 'text-right'
      )}
    />
  );
}

/**
 * A popover anchored on the cell. Esc cancels (or `onEscape`), a click outside commits through
 * `onOutside`. Pointer and key events stay inside.
 */
export function EditorPopover({
  label,
  width,
  onOutside,
  onEscape,
  children,
}: {
  label: string;
  width?: number;
  onOutside: () => void;
  onEscape: () => void;
  children: ReactNode;
}) {
  return (
    <PopoverPrimitive.Root open>
      <PopoverPrimitive.Anchor className="absolute inset-0" />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          role="dialog"
          aria-label={`Edit ${label}`}
          align="start"
          side="bottom"
          sideOffset={-34}
          collisionPadding={8}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            onEscape();
          }}
          onInteractOutside={(e) => {
            e.preventDefault();
            onOutside();
          }}
          onMouseDown={stop}
          onDoubleClick={stop}
          onKeyDown={stop}
          className="z-50 rounded-md border border-border bg-surface p-2 text-body text-text shadow-2 outline-none"
          style={{ width: width ?? 320 }}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/** Long text: an expanded textarea. Enter adds a line, Ctrl/⌘ Enter or Tab saves. */
function LongTextEditor({ field, value, initialText, onCommit, onCancel }: CellEditorProps) {
  const [draft, setDraft] = useState(
    initialText ?? (typeof value === 'string' ? value : cellText(field, value))
  );
  const once = useOnce();
  const commit = (move: EditorMove) =>
    once(() => onCommit({ value: parseInput(field, draft) }, move));
  // Rich text: the WYSIWYG editor on the Markdown.
  if ((fieldDef(field).options as { richText?: boolean }).richText === true) {
    return (
      <EditorPopover
        label={field.name}
        width={420}
        onOutside={() => commit('away')}
        onEscape={() => once(onCancel)}
      >
        <RichTextInput
          label={field.name}
          value={draft}
          onChange={setDraft}
          onSave={() => commit('stay')}
          onTab={(e) => commit(tabMove(e))}
        />
        <p className="mt-1.5 text-small text-text-2">
          Ctrl Enter to save, Esc to cancel, Ctrl click to open a link
        </p>
      </EditorPopover>
    );
  }
  return (
    <EditorPopover
      label={field.name}
      width={360}
      onOutside={() => commit('away')}
      onEscape={() => once(onCancel)}
    >
      <textarea
        // biome-ignore lint/a11y/noAutofocus: the editor opens on purpose
        autoFocus
        aria-label={field.name}
        value={draft}
        rows={6}
        onFocus={(e) => e.currentTarget.setSelectionRange(draft.length, draft.length)}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            commit('stay');
          } else if (e.key === 'Tab') {
            e.preventDefault();
            commit(tabMove(e));
          }
        }}
        className="block w-full resize-y rounded-sm border border-border bg-surface px-2 py-1.5 outline-none focus:border-brand"
      />
      <p className="mt-1.5 text-small text-text-2">Ctrl Enter to save, Esc to cancel</p>
    </EditorPopover>
  );
}

/**
 * Single and multiple select: a searchable list of the field's choices. Single select saves on
 * pick; multiple select toggles choices and saves when it closes (Esc, Tab, a click outside).
 * With `canAddOptions`, a search that matches no option by name offers "+ Add option" as the
 * last row: the cell is saved with the new name and `typecast`, and the server creates it.
 */
function SelectEditor({
  field,
  value,
  initialText,
  onCommit,
  onCancel,
  canAddOptions,
  multiple,
}: CellEditorProps & { multiple: boolean }) {
  const choices = choicesOf(field);
  // Choice ids, plus the names of options to add (multiple select).
  const [picked, setPicked] = useState(() => selectedIds(value));
  const [query, setQuery] = useState(initialText ?? '');
  const [hi, setHi] = useState(0);
  // Names picked through "+ Add option" in this edit.
  const [adding, setAdding] = useState<string[]>([]);
  const once = useOnce();
  const name = query.trim();
  const q = name.toLowerCase();
  const shown = q ? choices.filter((c) => c.name.toLowerCase().includes(q)) : choices;
  const added = picked.filter((id) => adding.includes(id));
  const canAdd =
    canAddOptions === true &&
    name !== '' &&
    name.length <= MAX_CHOICE_NAME &&
    !choices.some((c) => c.name.toLowerCase() === q) &&
    !added.some((n) => n.toLowerCase() === q);
  const rows = shown.length + (canAdd ? 1 : 0);
  const active = Math.min(hi, rows - 1);
  const save = (ids: string[], move: EditorMove, isNew = (id: string) => adding.includes(id)) =>
    once(() =>
      onCommit(
        {
          value: multiple ? (ids.length ? ids : null) : (ids[0] ?? null),
          ...(ids.some(isNew) ? { typecast: true } : {}),
        },
        move
      )
    );
  const add = () => {
    if (!multiple) return save([name], 'stay', () => true);
    setAdding((a) => [...a, name]);
    setPicked((p) => [...p, name]);
    setQuery('');
  };
  const pick = (id: string) => {
    if (!multiple) return save([id], 'stay');
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
    setQuery('');
  };
  const chipOf = (id: string): Choice | undefined =>
    choices.find((c) => c.id === id) ??
    (added.includes(id)
      ? { id, name: id, color: nextChoiceColor(choices.length + added.indexOf(id)) }
      : undefined);
  const listId = `select-${field.id}`;
  const addId = `${listId}-add`;
  return (
    <EditorPopover
      label={field.name}
      width={280}
      onOutside={() => (multiple ? save(picked, 'away') : once(onCancel))}
      onEscape={() => (multiple ? save(picked, 'stay') : once(onCancel))}
    >
      {multiple && picked.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {picked.map((id) => {
            const choice = chipOf(id);
            if (!choice) return null;
            return (
              <ChoiceChip key={id} choice={choice}>
                <button
                  type="button"
                  aria-label={`Remove ${choice.name}`}
                  onClick={() => setPicked((p) => p.filter((x) => x !== id))}
                  className="-mr-1 rounded-full opacity-70 hover:opacity-100"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </ChoiceChip>
            );
          })}
        </div>
      )}
      <input
        // biome-ignore lint/a11y/noAutofocus: the editor opens on purpose
        autoFocus
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={
          shown[active] ? `${listId}-${shown[active].id}` : canAdd && rows > 0 ? addId : undefined
        }
        aria-label={`Find an option for ${field.name}`}
        placeholder={canAddOptions ? 'Find or add an option' : 'Find an option'}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setHi(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHi(Math.min(active + 1, rows - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHi(Math.max(active - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const choice = shown[active];
            if (choice) pick(choice.id);
            else if (canAdd) add();
            else if (multiple) save(picked, 'stay');
          } else if (e.key === 'Tab') {
            e.preventDefault();
            if (multiple) save(picked, tabMove(e));
            else once(() => onCommit({ value: picked[0] ?? null }, tabMove(e)));
          } else if (e.key === 'Backspace' && multiple && query === '' && picked.length) {
            setPicked((p) => p.slice(0, -1));
          }
        }}
        className="h-8 w-full rounded-sm border border-border bg-surface px-2 outline-none focus:border-brand"
      />
      <div
        id={listId}
        role="listbox"
        aria-label={field.name}
        aria-multiselectable={multiple || undefined}
        className="mt-1 max-h-60 overflow-y-auto"
      >
        {shown.map((c, i) => {
          const selected = picked.includes(c.id);
          return (
            <div
              key={c.id}
              id={`${listId}-${c.id}`}
              role="option"
              aria-selected={selected}
              tabIndex={-1}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(c.id)}
              onKeyDown={() => {}}
              className={cn(
                'flex h-8 cursor-default items-center justify-between gap-2 rounded-sm px-1.5',
                i === active && 'bg-hover'
              )}
            >
              <ChoiceChip choice={c} />
              {selected && <Check aria-hidden className="size-4 text-primary" />}
            </div>
          );
        })}
        {canAdd && (
          <div
            id={addId}
            role="option"
            aria-selected={false}
            tabIndex={-1}
            onMouseEnter={() => setHi(shown.length)}
            onClick={add}
            onKeyDown={() => {}}
            className={cn(
              'flex h-8 cursor-default items-center gap-2 rounded-sm px-1.5',
              active === shown.length && 'bg-hover'
            )}
          >
            <Plus aria-hidden className="size-4 shrink-0 text-text-2" />
            <span className="truncate">
              Add option <span className="font-medium">"{name}"</span>
            </span>
          </div>
        )}
        {rows === 0 && (
          <p className="px-1.5 py-2 text-small text-text-2">
            {choices.length === 0 ? 'This field has no options yet' : 'No matching option'}
          </p>
        )}
      </div>
      {!multiple && picked.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 w-full justify-start"
          onClick={() => save([], 'stay')}
        >
          Clear
        </Button>
      )}
    </EditorPopover>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * Date and date-time: the browser's date picker (typed input works too). Date-times are picked
 * as wall-clock time in the field's time zone, which the editor names.
 */
function DateEditor({
  field,
  value,
  onCommit,
  onCancel,
  withTime,
}: CellEditorProps & { withTime: boolean }) {
  const { options } = fieldDef(field);
  const timeZone = (options as { timeZone?: string }).timeZone ?? 'UTC';
  const initial =
    typeof value === 'string'
      ? withTime
        ? instantInZone(value, timeZone).slice(0, 16)
        : value.slice(0, 10)
      : '';
  const [draft, setDraft] = useState(initial);
  const once = useOnce();
  const save = (text: string, move: EditorMove) =>
    once(() => {
      if (text === '') return onCommit({ value: null }, move);
      const parsed = coerceValue(field, text);
      onCommit(parsed === null ? { error: invalidMessage(field, text) } : { value: parsed }, move);
    });
  const nowText = () =>
    withTime ? instantInZone(new Date().toISOString(), timeZone).slice(0, 16) : localToday();
  return (
    <EditorPopover
      label={field.name}
      width={280}
      onOutside={() => (draft === initial ? once(onCancel) : save(draft, 'away'))}
      onEscape={() => once(onCancel)}
    >
      <input
        // biome-ignore lint/a11y/noAutofocus: the editor opens on purpose
        autoFocus
        type={withTime ? 'datetime-local' : 'date'}
        aria-label={field.name}
        value={draft}
        min={withTime ? '0001-01-01T00:00' : '0001-01-01'}
        max={withTime ? '9999-12-31T23:59' : '9999-12-31'}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            save(draft, 'stay');
          } else if (e.key === 'Tab') {
            e.preventDefault();
            save(draft, tabMove(e));
          }
        }}
        className="tnum h-8 w-full rounded-sm border border-border bg-surface px-2 outline-none focus:border-brand"
      />
      {withTime && (
        <p className="mt-1.5 text-small text-text-2" data-testid="time-zone">
          Time zone: {timeZone}
        </p>
      )}
      <div className="mt-2 flex gap-1">
        <Button size="sm" onClick={() => save(draft, 'stay')}>
          Save
        </Button>
        <Button variant="ghost" size="sm" onClick={() => save(nowText(), 'stay')}>
          {withTime ? 'Now' : 'Today'}
        </Button>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => save('', 'stay')}>
          Clear
        </Button>
      </div>
    </EditorPopover>
  );
}

const fileSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Attachments: the files (thumbnail, name linking to the download, size), each removable, and
 * "Add files" (a file picker, or drop files on the popover) uploading into the cell.
 */
function AttachmentEditor({ field, value, onCommit, onCancel }: CellEditorProps) {
  const initial = (Array.isArray(value) ? value : []) as AttachmentValue[];
  const [files, setFiles] = useState(initial);
  const [uploading, setUploading] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const once = useOnce();
  const changed = files.map((f) => f.id).join() !== initial.map((f) => f.id).join();
  const close = (move: EditorMove) => {
    if (uploading > 0) return;
    once(() => (changed ? onCommit({ value: files.length ? files : null }, move) : onCancel()));
  };
  const add = async (picked: File[]) => {
    if (picked.length === 0) return;
    setProblem(null);
    setUploading(picked.length);
    const { uploaded, error } = await uploadFiles(field.tableId, field.id, picked);
    setUploading(0);
    setFiles((all) => [...all, ...uploaded.filter((u) => !all.some((f) => f.id === u.id))]);
    if (error) setProblem(error instanceof Error ? error.message : "Couldn't upload the file.");
  };
  return (
    <EditorPopover
      label={field.name}
      onOutside={() => close('away')}
      onEscape={() => close('stay')}
    >
      <section
        aria-label="Files"
        onDragOver={(e) => {
          if (!dragHasFiles(e)) return;
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          if (!dragHasFiles(e)) return;
          e.preventDefault();
          setDropping(false);
          void add([...e.dataTransfer.files]);
        }}
        className={cn(
          'rounded-sm',
          dropping && 'outline-1 -outline-offset-1 outline-dashed outline-primary'
        )}
      >
        {files.length === 0 ? (
          <p className="px-1 py-2 text-small text-text-2">No files. Drop files here or add them.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {files.map((f) => (
              <li key={f.id} className="flex items-center gap-2 rounded-sm px-1 py-1">
                <AttachmentTile tableId={field.tableId} file={f} />
                <a
                  href={fileUrl(field.tableId, f.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 flex-1 truncate hover:underline"
                >
                  {f.filename}
                </a>
                <span className="tnum text-small text-text-2">{fileSize(f.size)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${f.filename}`}
                  onClick={() => setFiles((all) => all.filter((x) => x.id !== f.id))}
                  className="rounded-xs p-0.5 text-text-2 hover:bg-hover hover:text-text"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {uploading > 0 && (
        <p role="status" className="mt-2 text-small text-text-2">
          Uploading {uploading === 1 ? '1 file' : `${uploading} files`}…
        </p>
      )}
      {problem && (
        <p role="alert" className="mt-2 text-small text-danger">
          {problem}
        </p>
      )}
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label="Choose files"
        onChange={(e) => {
          const picked = [...(e.target.files ?? [])];
          e.target.value = '';
          void add(picked);
        }}
      />
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={uploading > 0}
          onClick={() => input.current?.click()}
        >
          <Paperclip className="size-3.5" aria-hidden />
          Add files
        </Button>
        <Button
          size="sm"
          className="ml-auto"
          disabled={uploading > 0}
          onClick={() => close('stay')}
        >
          Done
        </Button>
      </div>
    </EditorPopover>
  );
}

/** `value`, once it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * The link picker: the linked records as chips (× unlinks), and a search over the linked
 * table's primary field (`GET /api/fields/:id/link-candidates`, limited to the field's view if
 * it has one). With "allow multiple" off, a pick saves; otherwise picks toggle and the cell saves
 * when the editor closes (Esc, Tab, a click outside). A search matching no record by name offers
 * "Add …": the cell is saved with the name and `typecast`, and the server creates the record.
 */
export function LinkEditor({ field, value, initialText, onCommit, onCancel }: CellEditorProps) {
  const single = (fieldDef(field).options as LinkOptions).prefersSingleRecordLink;
  const [picked, setPicked] = useState<(LinkCellItem | string)[]>(() => linkItems(value));
  const [query, setQuery] = useState(initialText ?? '');
  const [hi, setHi] = useState(0);
  const search = useDebounced(query.trim(), 150);
  const { data, isFetching, isError } = useLinkCandidates(field.id, search);
  const once = useOnce();
  const name = query.trim();
  const candidates = data?.records ?? [];
  const isPicked = (id: string) => picked.some((p) => typeof p !== 'string' && p.id === id);
  const canAdd =
    name !== '' &&
    search === name &&
    !isFetching &&
    !candidates.some((c) => c.name.toLowerCase() === name.toLowerCase()) &&
    !picked.some((p) => typeof p === 'string' && p.toLowerCase() === name.toLowerCase());
  const rows = candidates.length + (canAdd ? 1 : 0);
  const active = Math.min(hi, rows - 1);
  const save = (items: (LinkCellItem | string)[], move: EditorMove) =>
    once(() =>
      onCommit(
        {
          value: items.length ? items : null,
          ...(items.some((i) => typeof i === 'string') ? { typecast: true } : {}),
        },
        move
      )
    );
  const pick = (item: LinkCellItem | string) => {
    if (single) return save([item], 'stay');
    setPicked((p) =>
      typeof item !== 'string' && isPicked(item.id)
        ? p.filter((x) => typeof x === 'string' || x.id !== item.id)
        : [...p, item]
    );
    setQuery('');
    setHi(0);
  };
  const listId = `link-${field.id}`;
  const addId = `${listId}-add`;
  const optionId = (id: string) => `${listId}-${id}`;
  const chipName = (p: LinkCellItem | string) => (typeof p === 'string' ? p : p.name);
  return (
    <EditorPopover
      label={field.name}
      width={320}
      onOutside={() => (single ? once(onCancel) : save(picked, 'away'))}
      onEscape={() => (single ? once(onCancel) : save(picked, 'stay'))}
    >
      {picked.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {picked.map((p, i) => (
            <LinkChip key={typeof p === 'string' ? `new-${p}` : p.id} name={chipName(p)}>
              <button
                type="button"
                aria-label={`Unlink ${chipName(p) || 'Unnamed record'}`}
                onClick={() =>
                  single ? save([], 'stay') : setPicked((all) => all.filter((_, j) => j !== i))
                }
                className="-mr-0.5 rounded-xs text-text-2 hover:text-text"
              >
                <X className="size-3" aria-hidden />
              </button>
            </LinkChip>
          ))}
        </div>
      )}
      <input
        // biome-ignore lint/a11y/noAutofocus: the editor opens on purpose
        autoFocus
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={
          candidates[active]
            ? optionId(candidates[active].id)
            : canAdd && rows > 0
              ? addId
              : undefined
        }
        aria-label={`Find a record for ${field.name}`}
        placeholder="Find a record"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setHi(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHi(Math.min(active + 1, rows - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHi(Math.max(active - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const candidate = candidates[active];
            if (candidate) pick(candidate);
            else if (canAdd) pick(name);
            else if (!single) save(picked, 'stay');
          } else if (e.key === 'Tab') {
            e.preventDefault();
            if (single) once(onCancel);
            else save(picked, tabMove(e));
          } else if (e.key === 'Backspace' && !single && query === '' && picked.length) {
            setPicked((p) => p.slice(0, -1));
          }
        }}
        className="h-8 w-full rounded-sm border border-border bg-surface px-2 outline-none focus:border-brand"
      />
      <div
        id={listId}
        role="listbox"
        aria-label={`Records for ${field.name}`}
        aria-multiselectable={!single || undefined}
        aria-busy={isFetching || undefined}
        className="mt-1 max-h-60 overflow-y-auto"
      >
        {candidates.map((c, i) => {
          const selected = isPicked(c.id);
          return (
            <div
              key={c.id}
              id={optionId(c.id)}
              role="option"
              aria-selected={selected}
              tabIndex={-1}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(c)}
              onKeyDown={() => {}}
              className={cn(
                'flex h-8 cursor-default items-center justify-between gap-2 rounded-sm px-1.5',
                i === active && 'bg-hover'
              )}
            >
              <span className={cn('truncate', !c.name && 'text-text-2')}>
                {c.name || 'Unnamed record'}
              </span>
              {selected && <Check aria-hidden className="size-4 shrink-0 text-primary" />}
            </div>
          );
        })}
        {canAdd && (
          <div
            id={addId}
            role="option"
            aria-selected={false}
            tabIndex={-1}
            onMouseEnter={() => setHi(candidates.length)}
            onClick={() => pick(name)}
            onKeyDown={() => {}}
            className={cn(
              'flex h-8 cursor-default items-center gap-2 rounded-sm px-1.5',
              active === candidates.length && 'bg-hover'
            )}
          >
            <Plus aria-hidden className="size-4 shrink-0 text-text-2" />
            <span className="truncate">
              Add <span className="font-medium">"{name}"</span>
            </span>
          </div>
        )}
        {rows === 0 && (
          <p className="px-1.5 py-2 text-small text-text-2">
            {isError ? "Records couldn't be loaded" : data ? 'No matching record' : 'Loading…'}
          </p>
        )}
      </div>
    </EditorPopover>
  );
}

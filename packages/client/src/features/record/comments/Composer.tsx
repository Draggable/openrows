import { type Collaborator, MAX_COMMENT_LENGTH } from '@openrows/shared';
import { useQuery } from '@tanstack/react-query';
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { commentQueries } from '../../../api/queries';
import { Button } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { useDirectory } from '../../collaborators/context';
import { Avatar } from '../../collaborators/UserChip';
import {
  caretText,
  caretToEnd,
  deleteChipBeforeCaret,
  insertText,
  readSegments,
  renderSegments,
  replaceWithChip,
  tidy,
} from './editor';
import { mentionQuery, mentionSuggestions, type Segment, toBody, toSegments } from './model';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** The typed `@query` at the caret: its text node and range. */
interface Query {
  node: Text;
  start: number;
  end: number;
  query: string;
}

/**
 * A comment box with @mention chips. `@` plus letters lists people with access to
 * the base (↑/↓, Enter or Tab picks, Esc closes); a pick becomes a chip, one unit for the caret
 * and Backspace, that stands for that person whatever their name says. Ctrl/⌘ Enter submits,
 * Enter adds a line. Pastes go in as plain text.
 */
export function Composer({
  tableId,
  label,
  submitLabel,
  initialBody = '',
  autoFocus = false,
  pending,
  onSubmit,
  onCancel,
}: {
  tableId: string;
  label: string;
  submitLabel: string;
  /** A stored body to edit. */
  initialBody?: string;
  autoFocus?: boolean;
  pending: boolean;
  onSubmit: (body: string, done: () => void) => void;
  onCancel?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [at, setAt] = useState<Query | null>(null);
  const [active, setActive] = useState(0);
  // The `@query` Esc closed (its text node and start), until another one is typed.
  const [dismissed, setDismissed] = useState<{ node: Text; start: number } | null>(null);
  const listId = useId();
  const hintId = `${listId}-hint`;
  const { list, byId } = useDirectory();
  const mentionable = useQuery(commentQueries.mentionable(tableId));
  const allowed = useMemo(
    () => (mentionable.data ? new Set(mentionable.data.userIds) : undefined),
    [mentionable.data]
  );
  const suggestions: Collaborator[] =
    at && !(at.node === dismissed?.node && at.start === dismissed.start)
      ? mentionSuggestions(list, allowed, at.query)
      : [];
  const open = suggestions.length > 0;
  const body = toBody(segments);
  const tooLong = body.length > MAX_COMMENT_LENGTH;

  /** Reads the box back: its segments and the `@query` at the caret. */
  const sync = useCallback(() => {
    const root = box.current;
    if (!root) return;
    setSegments(readSegments(root));
    const caret = caretText(root);
    const q = caret ? mentionQuery(caret.node.data, caret.offset) : null;
    setAt(
      caret && q ? { node: caret.node, start: q.start, end: caret.offset, query: q.query } : null
    );
  }, []);

  // The initial body (an edit), once; the directory's names for its mentions.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on mount
  useEffect(() => {
    const root = box.current;
    if (!root) return;
    renderSegments(
      root,
      toSegments(initialBody, (id) => byId.get(id)?.name)
    );
    setSegments(readSegments(root));
    if (autoFocus) {
      root.focus();
      caretToEnd(root);
    }
  }, []);

  // The caret moves without input (clicks, arrows): follow it while the box has the focus.
  useEffect(() => {
    const onSelection = () => {
      if (box.current && document.activeElement === box.current) sync();
    };
    document.addEventListener('selectionchange', onSelection);
    return () => document.removeEventListener('selectionchange', onSelection);
  }, [sync]);

  const pick = (person: Collaborator) => {
    const root = box.current;
    if (!root || !at || !root.contains(at.node)) return;
    replaceWithChip(root, at.node, at.start, at.end, person);
    root.focus();
    setActive(0);
    sync();
  };

  const submit = () => {
    if (pending || tooLong || !body) return;
    onSubmit(body, () => {
      box.current?.replaceChildren();
      setSegments([]);
      setAt(null);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const root = box.current;
    if (!root) return;
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((i) => (i + step + suggestions.length) % suggestions.length);
        return;
      }
      if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') {
        e.preventDefault();
        const person = suggestions[Math.min(active, suggestions.length - 1)];
        if (person) pick(person);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(at ? { node: at.node, start: at.start } : null);
        return;
      }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Enter') {
      // A newline in the text, never a browser-made <div> or <br>.
      e.preventDefault();
      insertText(root, '\n');
      sync();
    } else if (e.key === 'Backspace' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (deleteChipBeforeCaret(root)) {
        e.preventDefault();
        sync();
      }
    } else if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      onCancel();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const root = box.current;
    if (!root) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
    if (text) insertText(root, text);
    sync();
  };

  // Formatting (Ctrl B and the like) and drops would bring in HTML: the box is plain text.
  const onBeforeInput = (e: FormEvent<HTMLDivElement>) => {
    const type = (e.nativeEvent as InputEvent).inputType ?? '';
    if (type.startsWith('format') || type === 'insertFromDrop') e.preventDefault();
  };

  const empty = segments.length === 0;

  return (
    <div className="relative">
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label="People to mention"
          className="absolute right-0 bottom-full left-0 z-50 mb-1 max-h-60 overflow-y-auto rounded-md border border-border bg-surface p-1 shadow-2"
        >
          {suggestions.map((person, i) => (
            <div
              key={person.id}
              id={`${listId}-${person.id}`}
              role="option"
              aria-selected={i === active}
              tabIndex={-1}
              onKeyDown={() => {}}
              onMouseDown={(e) => {
                // Keep the focus (and the caret) in the box.
                e.preventDefault();
                pick(person);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                'flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2',
                i === active && 'bg-selected'
              )}
            >
              <Avatar person={person} />
              <span className="truncate">{person.name}</span>
              {person.email && (
                <span className="truncate text-small text-text-2">{person.email}</span>
              )}
            </div>
          ))}
        </div>
      )}
      <div
        className={cn(
          'relative rounded-md border border-border bg-surface focus-within:border-brand',
          tooLong && 'border-danger'
        )}
      >
        {empty && (
          <span
            aria-hidden
            className="pointer-events-none absolute top-2 left-3 text-text-2 select-none"
          >
            Write a comment… (@ to mention)
          </span>
        )}
        <div
          ref={box}
          role="combobox"
          tabIndex={0}
          contentEditable
          suppressContentEditableWarning
          aria-label={label}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={
            open && suggestions[active] ? `${listId}-${suggestions[active].id}` : undefined
          }
          aria-describedby={hintId}
          aria-keyshortcuts="Control+Enter Meta+Enter"
          // While the suggestions are open (or an edit is open), Esc is the box's.
          data-keeps-escape={open || onCancel ? 'true' : undefined}
          data-testid="comment-composer"
          onInput={() => {
            const root = box.current;
            if (root) tidy(root);
            setActive(0);
            sync();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBeforeInput={onBeforeInput}
          onDrop={(e) => e.preventDefault()}
          className="block max-h-40 min-h-[52px] w-full overflow-y-auto px-3 py-2 break-words whitespace-pre-wrap outline-none"
        />
        <div className="flex items-center justify-end gap-2 px-2 pb-2">
          {tooLong && (
            <span className="mr-auto text-small text-danger">
              {body.length.toLocaleString()} / {MAX_COMMENT_LENGTH.toLocaleString()}
            </span>
          )}
          {/* Enter adds a line, as in the long text editor; the hint says how to send. */}
          <span id={hintId} className="text-small text-text-2 pointer-coarse:hidden">
            <kbd className="font-sans">{isMac ? '⌘' : 'Ctrl'} Enter</kbd> to{' '}
            {submitLabel.toLowerCase()}
          </span>
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button size="sm" disabled={pending || tooLong || !body} onClick={submit}>
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

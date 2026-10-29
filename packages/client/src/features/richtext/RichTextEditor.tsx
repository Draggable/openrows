import { isSafeLinkUrl } from '@openrows/shared';
import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import {
  Bold,
  Code,
  FileCode,
  Heading,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Quote,
  Strikethrough,
} from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import { richTextExtensions } from './extensions';
import { docToMarkdown, markdownToDoc } from './markdown-doc';
import { sanitizePastedHtml } from './paste';

/**
 * The WYSIWYG rich text editor, a lazy chunk (TipTap/ProseMirror stay out of the grid's
 * bundle). It reads and writes rich text Markdown through `markdown-doc.ts`; "Markdown" shows
 * the source in a textarea. Links open with Ctrl/⌘ click, in a new tab without an opener.
 */
export interface RichTextEditorProps {
  label: string;
  value: string;
  onChange: (markdown: string) => void;
  onSave?: () => void;
  onTab?: (e: { shiftKey: boolean }) => void;
}

/** A link the user typed: a bare domain gets https://; only http(s) and mailto pass. */
export function linkHref(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const href = /^[a-z][a-z0-9+.-]*:/i.test(text)
    ? text
    : text.includes('@') && !text.includes('/')
      ? `mailto:${text}`
      : `https://${text}`;
  return isSafeLinkUrl(href) ? href : null;
}

/** Opens a link from the editor, only when it is safe, never with an opener. */
function openLink(href: string) {
  if (isSafeLinkUrl(href)) window.open(href, '_blank', 'noopener,noreferrer');
}

type Tool = {
  label: string;
  keys?: string;
  icon: typeof Bold;
  active: (e: Editor) => boolean;
  run: (e: Editor) => void;
};

const TOOLS: Tool[] = [
  {
    label: 'Bold',
    keys: 'B',
    icon: Bold,
    active: (e) => e.isActive('bold'),
    run: (e) => e.chain().focus().toggleBold().run(),
  },
  {
    label: 'Italic',
    keys: 'I',
    icon: Italic,
    active: (e) => e.isActive('italic'),
    run: (e) => e.chain().focus().toggleItalic().run(),
  },
  {
    label: 'Strikethrough',
    icon: Strikethrough,
    active: (e) => e.isActive('strike'),
    run: (e) => e.chain().focus().toggleStrike().run(),
  },
  {
    label: 'Code',
    icon: Code,
    active: (e) => e.isActive('code'),
    run: (e) => e.chain().focus().toggleCode().run(),
  },
  {
    label: 'Heading',
    icon: Heading,
    active: (e) => e.isActive('heading'),
    run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    label: 'Bulleted list',
    icon: List,
    active: (e) => e.isActive('bulletList'),
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    label: 'Numbered list',
    icon: ListOrdered,
    active: (e) => e.isActive('orderedList'),
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    label: 'Checklist',
    icon: ListChecks,
    active: (e) => e.isActive('taskList'),
    run: (e) => e.chain().focus().toggleTaskList().run(),
  },
  {
    label: 'Quote',
    icon: Quote,
    active: (e) => e.isActive('blockquote'),
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
];

function ToolButton({
  title,
  pressed,
  onClick,
  children,
}: {
  title: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-sm text-text-2 hover:bg-hover hover:text-text',
        pressed && 'bg-selected text-primary'
      )}
    >
      {children}
    </button>
  );
}

export default function RichTextEditor({
  label,
  value,
  onChange,
  onSave,
  onTab,
}: RichTextEditorProps) {
  const [source, setSource] = useState<string | null>(null);
  const [linkDraft, setLinkDraft] = useState<string | null>(null);
  const [linkError, setLinkError] = useState(false);
  // The latest callbacks, for the editor's handlers (created once).
  const handlers = useRef({ onChange, onSave, onTab });
  handlers.current = { onChange, onSave, onTab };

  const editor = useEditor({
    extensions: richTextExtensions(),
    content: markdownToDoc(value),
    autofocus: 'end',
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': label,
        class:
          'rich-text-editor min-h-32 max-h-80 overflow-y-auto rounded-sm border border-border bg-surface px-2 py-1.5 outline-none focus:border-brand',
      },
      // Pasted HTML is cleaned in an inert document before the editor reads it.
      transformPastedHTML: (html) => sanitizePastedHtml(html),
      handleKeyDown: (_view, event) => {
        const mod = event.ctrlKey || event.metaKey;
        if (event.key === 'Enter' && mod && handlers.current.onSave) {
          event.preventDefault();
          handlers.current.onSave();
          return true;
        }
        if (event.key === 'Tab' && handlers.current.onTab) {
          event.preventDefault();
          handlers.current.onTab(event);
          return true;
        }
        return false;
      },
      // Ctrl/⌘ click opens a link (a plain click places the caret, as in any editor).
      handleClick: (view, pos, event) => {
        if (!(event.ctrlKey || event.metaKey)) return false;
        const link = view.state.doc
          .resolve(pos)
          .marks()
          .find((m) => m.type.name === 'link');
        const href = link?.attrs['href'];
        if (typeof href !== 'string') return false;
        event.preventDefault();
        openLink(href);
        return true;
      },
    },
    onUpdate: ({ editor: e }) => handlers.current.onChange(docToMarkdown(e.getJSON())),
  });

  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      tools: TOOLS.map((t) => (e ? t.active(e) : false)),
      link: e?.isActive('link') ?? false,
    }),
  });

  const applyLink = () => {
    if (linkDraft === null) return;
    const href = linkHref(linkDraft);
    if (!href) {
      setLinkError(true);
      return;
    }
    const chain = editor.chain().focus().extendMarkRange('link');
    if (editor.state.selection.empty && !editor.isActive('link'))
      chain.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] });
    else chain.setLink({ href });
    chain.run();
    setLinkDraft(null);
    setLinkError(false);
  };

  const toggleSource = () => {
    if (source === null) {
      setLinkDraft(null);
      setSource(docToMarkdown(editor.getJSON()));
    } else {
      editor.commands.setContent(markdownToDoc(source), { emitUpdate: false });
      onChange(docToMarkdown(editor.getJSON()));
      setSource(null);
      editor.commands.focus('end');
    }
  };

  return (
    <div>
      <div role="toolbar" aria-label="Formatting" className="mb-1 flex items-center gap-0.5">
        {source === null && (
          <>
            {TOOLS.map((t, i) => (
              <ToolButton
                key={t.label}
                title={t.keys ? `${t.label} (Ctrl ${t.keys})` : t.label}
                pressed={active.tools[i]}
                onClick={() => t.run(editor)}
              >
                <t.icon aria-hidden className="size-4" />
              </ToolButton>
            ))}
            <ToolButton
              title={active.link ? 'Remove link' : 'Link'}
              pressed={active.link}
              onClick={() => {
                if (editor.isActive('link'))
                  editor.chain().focus().extendMarkRange('link').unsetLink().run();
                else setLinkDraft('');
              }}
            >
              <Link aria-hidden className="size-4" />
            </ToolButton>
          </>
        )}
        <span className="flex-1" />
        <ToolButton title="Markdown" pressed={source !== null} onClick={toggleSource}>
          <FileCode aria-hidden className="size-4" />
        </ToolButton>
      </div>
      {linkDraft !== null && (
        <div className="mb-1 flex items-center gap-1">
          <input
            // biome-ignore lint/a11y/noAutofocus: the link form opens on purpose
            autoFocus
            aria-label="Link URL"
            aria-invalid={linkError || undefined}
            placeholder="https://"
            value={linkDraft}
            onChange={(e) => {
              setLinkDraft(e.target.value);
              setLinkError(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                applyLink();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setLinkDraft(null);
                setLinkError(false);
                editor.commands.focus();
              }
            }}
            className={cn(
              'h-7 min-w-0 flex-1 rounded-sm border border-border bg-surface px-2 outline-none focus:border-brand',
              linkError && 'border-danger'
            )}
          />
          <button
            type="button"
            onClick={applyLink}
            className="h-7 rounded-sm bg-primary px-2 text-small text-primary-foreground hover:opacity-90"
          >
            Add link
          </button>
        </div>
      )}
      {linkError && (
        <p role="alert" className="mb-1 text-small text-danger">
          Links must start with http://, https:// or mailto:
        </p>
      )}
      {/* The editor stays mounted (hidden) while the source shows, so it keeps its history. */}
      <div hidden={source !== null}>
        <EditorContent editor={editor} />
      </div>
      {source !== null && (
        <textarea
          // biome-ignore lint/a11y/noAutofocus: the source view opens on purpose
          autoFocus
          aria-label={`${label} (Markdown)`}
          value={source}
          rows={8}
          onChange={(e) => {
            setSource(e.target.value);
            onChange(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && onSave) {
              e.preventDefault();
              onSave();
            } else if (e.key === 'Tab' && onTab) {
              e.preventDefault();
              onTab(e);
            }
          }}
          className="block w-full resize-y rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-[12px] outline-none focus:border-brand"
        />
      )}
    </div>
  );
}

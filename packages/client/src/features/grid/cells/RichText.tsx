import {
  type MarkdownBlock,
  type MarkdownInline,
  parseComment,
  parseMarkdown,
} from '@openrows/shared';
import { lazy, Suspense } from 'react';
import { cn } from '../../../lib/utils';
import { useDirectory } from '../../collaborators/context';
import { MENTION_CHIP_CLASS } from '../../record/comments/editor';
import type { RichTextEditorProps } from '../../richtext/RichTextEditor';

/**
 * An @mention in a comment: the person's current name from the directory (the token's
 * label only while it loads, or for someone no longer listed).
 */
function Mention({ userId, label }: { userId: string; label: string }) {
  const { byId } = useDirectory();
  const name = byId.get(userId)?.name ?? label;
  return (
    <span data-testid="mention" data-user-id={userId} className={MENTION_CHIP_CLASS}>
      @{name}
    </span>
  );
}

/**
 * Rich text: Markdown rendered from the shared parser's tree with plain elements. Nothing
 * is ever set as HTML, and links are only http(s) or mailto (the parser drops the rest), opened
 * in a new tab with `rel="noopener noreferrer"`.
 */
function Inline({ nodes, links }: { nodes: MarkdownInline[]; links: boolean }) {
  return (
    <>
      {nodes.map((n, i) => {
        const key = `${i}-${n.kind}`;
        switch (n.kind) {
          case 'text':
            return <span key={key}>{n.text}</span>;
          case 'code':
            return (
              <code key={key} className="rounded-xs bg-hover px-1 font-mono text-[12px]">
                {n.text}
              </code>
            );
          case 'bold':
            return (
              <strong key={key} className="font-semibold">
                <Inline nodes={n.children} links={links} />
              </strong>
            );
          case 'italic':
            return (
              <em key={key}>
                <Inline nodes={n.children} links={links} />
              </em>
            );
          case 'strike':
            return (
              <s key={key}>
                <Inline nodes={n.children} links={links} />
              </s>
            );
          case 'link':
            // Inside something clickable (the record view's edit box) a link is only styled.
            if (!links) {
              return (
                <span key={key} className="underline decoration-border-strong underline-offset-2">
                  <Inline nodes={n.children} links={links} />
                </span>
              );
            }
            return (
              <a
                key={key}
                href={n.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-text underline decoration-border-strong underline-offset-2 hover:decoration-text"
              >
                <Inline nodes={n.children} links={links} />
              </a>
            );
          case 'mention':
            return <Mention key={key} userId={n.userId} label={n.label} />;
          default:
            return null;
        }
      })}
    </>
  );
}

function Block({ block, links }: { block: MarkdownBlock; links: boolean }) {
  switch (block.kind) {
    case 'heading': {
      const size = block.level === 1 ? 'text-[16px]' : block.level === 2 ? 'text-[14px]' : '';
      const Tag = `h${block.level + 2}` as 'h3' | 'h4' | 'h5';
      return (
        <Tag className={cn('font-semibold', size)}>
          <Inline nodes={block.children} links={links} />
        </Tag>
      );
    }
    case 'quote':
      return (
        <blockquote className="whitespace-pre-wrap pl-3 text-text-2 italic">
          <Inline nodes={block.children} links={links} />
        </blockquote>
      );
    case 'code':
      return (
        <pre className="overflow-x-auto rounded-sm bg-hover p-2 font-mono text-[12px]">
          {block.text}
        </pre>
      );
    case 'list': {
      const items = block.items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: list items have no identity but order
        <li key={i} className={cn(item.checked !== null && 'flex list-none items-start gap-1.5')}>
          {item.checked !== null && (
            <input
              type="checkbox"
              checked={item.checked}
              readOnly
              disabled
              aria-label={item.checked ? 'Done' : 'Not done'}
              className="mt-0.5 accent-primary"
            />
          )}
          <span>
            <Inline nodes={item.children} links={links} />
          </span>
        </li>
      ));
      return block.ordered ? (
        <ol className="list-decimal pl-5">{items}</ol>
      ) : (
        <ul className="list-disc pl-5">{items}</ul>
      );
    }
    default:
      return (
        <p className="whitespace-pre-wrap">
          <Inline nodes={block.children} links={links} />
        </p>
      );
  }
}

/**
 * Rendered rich text. `links: false` styles links without making them clickable; `comment`
 * parses a comment body, with its @mentions.
 */
export function RichText({
  text,
  className,
  links = true,
  comment = false,
}: {
  text: string;
  className?: string;
  links?: boolean;
  comment?: boolean;
}) {
  const blocks = comment ? parseComment(text) : parseMarkdown(text);
  return (
    <div data-testid="rich-text" className={cn('flex flex-col gap-1.5', className)}>
      {blocks.map((b, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no identity but order
        <Block key={i} block={b} links={links} />
      ))}
    </div>
  );
}

const RichTextEditor = lazy(() => import('../../richtext/RichTextEditor'));

/**
 * The rich text input: the WYSIWYG editor (TipTap, loaded on first use) on the same
 * Markdown, with a Markdown source view. The server sanitizes what it saves either way.
 */
export function RichTextInput(props: RichTextEditorProps) {
  return (
    <Suspense
      fallback={
        <div
          aria-busy
          className="min-h-32 rounded-sm border border-border bg-surface px-2 py-1.5 text-text-3"
        >
          Loading editor…
        </div>
      }
    >
      <RichTextEditor {...props} />
    </Suspense>
  );
}

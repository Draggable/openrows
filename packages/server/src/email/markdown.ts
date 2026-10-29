import { type MarkdownBlock, type MarkdownInline, parseMarkdown } from '@openrows/shared';
import { html, type SafeHtml, safeUrl } from './html.js';

/**
 * Markdown as email HTML (automation emails), through the same parser the client renders
 * rich text with: every piece of text is escaped by `html`, links are only http(s) or
 * mailto (`isSafeLinkUrl` in the parser, `safeUrl` again here), and nothing else (no raw HTML,
 * images or styles from the author) gets through.
 */
function inline(nodes: readonly MarkdownInline[]): SafeHtml {
  return html`${nodes.map((n): SafeHtml => {
    switch (n.kind) {
      case 'text':
        return html`${n.text}`;
      case 'code':
        return html`<code>${n.text}</code>`;
      case 'bold':
        return html`<strong>${inline(n.children)}</strong>`;
      case 'italic':
        return html`<em>${inline(n.children)}</em>`;
      case 'strike':
        return html`<s>${inline(n.children)}</s>`;
      case 'link': {
        const href = safeUrl(n.href) ?? (n.href.startsWith('mailto:') ? n.href : undefined);
        return href ? html`<a href="${href}">${inline(n.children)}</a>` : inline(n.children);
      }
      default:
        // A mention (comments only): its name.
        return html`@${n.label}`;
    }
  })}`;
}

function block(b: MarkdownBlock): SafeHtml {
  switch (b.kind) {
    case 'paragraph':
      return html`<p>${inline(b.children)}</p>`;
    case 'heading':
      return b.level === 1
        ? html`<h1 style="font-size: 20px;">${inline(b.children)}</h1>`
        : b.level === 2
          ? html`<h2 style="font-size: 17px;">${inline(b.children)}</h2>`
          : html`<h3 style="font-size: 15px;">${inline(b.children)}</h3>`;
    case 'quote':
      return html`<blockquote style="margin: 0 0 0 12px; color: #444;">${inline(b.children)}</blockquote>`;
    case 'code':
      return html`<pre style="background: #f4f2ec; padding: 8px;">${b.text}</pre>`;
    case 'list': {
      const items = b.items.map(
        (item) =>
          html`<li>${item.checked === null ? '' : item.checked ? '☑ ' : '☐ '}${inline(item.children)}</li>`
      );
      return b.ordered ? html`<ol>${items}</ol>` : html`<ul>${items}</ul>`;
    }
  }
}

export function markdownEmailHtml(text: string): SafeHtml {
  return html`${parseMarkdown(text).map(block)}`;
}

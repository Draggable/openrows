import { isSafeLinkUrl } from '@openrows/shared';

/**
 * Pasted HTML, cleaned before the editor parses it. The editor's schema already keeps only
 * the rich text subset, but ProseMirror reads the HTML in a live document first; here it is read
 * in an inert `DOMParser` document (no scripts, no loads, no handlers) and only the tags the
 * subset maps from survive, with no attributes but a safe `href`, the task list markers and the
 * inline styles that mean bold, italic or strikethrough.
 */

/** Elements dropped with everything inside them. */
const DROP = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'svg',
  'math',
  'template',
  'noscript',
  'img',
  'picture',
  'video',
  'audio',
  'canvas',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'link',
  'meta',
  'base',
  'head',
  'title',
]);

/** Elements kept (without their attributes); any other is replaced by its content. */
const KEEP = new Set([
  'p',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'b',
  'em',
  'i',
  's',
  'strike',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'a',
  'div',
  'span',
]);

const STYLES = ['font-weight', 'font-style', 'text-decoration', 'text-decoration-line'];

function cleanElement(el: Element) {
  for (const child of [...el.children]) {
    const tag = child.localName.toLowerCase();
    if (DROP.has(tag)) {
      child.remove();
      continue;
    }
    cleanElement(child);
    if (!KEEP.has(tag)) {
      child.replaceWith(...child.childNodes);
      continue;
    }
    const href = tag === 'a' ? child.getAttribute('href')?.trim() : undefined;
    const type = child.getAttribute('data-type');
    const checked = child.getAttribute('data-checked');
    const slice = child.getAttribute('data-pm-slice');
    const style = (child as HTMLElement).style;
    const kept = style
      ? STYLES.map((p) => [p, style.getPropertyValue(p)] as const).filter(([, v]) =>
          /^[a-z0-9 -]+$/i.test(v)
        )
      : [];
    for (const name of child.getAttributeNames()) child.removeAttribute(name);
    if (href && isSafeLinkUrl(href)) child.setAttribute('href', href);
    if (type === 'taskList' || type === 'taskItem') child.setAttribute('data-type', type);
    if (checked === 'true' || checked === 'false') child.setAttribute('data-checked', checked);
    // ProseMirror's own copy marker: open depths and the context, numbers and node names.
    if (slice && /^[\w\s"[\]{},:.-]*$/.test(slice)) child.setAttribute('data-pm-slice', slice);
    if (kept.length) child.setAttribute('style', kept.map(([p, v]) => `${p}: ${v}`).join('; '));
  }
}

/** Pasted HTML with only what the rich text subset can hold. */
export function sanitizePastedHtml(html: string): string {
  // Handler attributes are renamed first: a browser checks one against the CSP (and reports it)
  // as soon as it parses it, even in an inert document. The element pass below still removes
  // every attribute it doesn't know, whatever this misses.
  const renamed = html.replace(/<[^<>]*>/g, (tag) =>
    tag.replace(/([\s/"'])on([a-z]+\s*=)/gi, '$1data-x-on$2')
  );
  const doc = new DOMParser().parseFromString(renamed, 'text/html');
  cleanElement(doc.body);
  return doc.body.innerHTML;
}

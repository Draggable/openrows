import type { Segment } from './model';

/**
 * The comment composer's editable DOM: a contenteditable box of text nodes and mention
 * chips (`<span contenteditable="false" data-mention-id>`), never HTML from outside (pastes go
 * in as text). These helpers read it back as segments and edit it at the caret.
 */

export const CHIP_ATTR = 'data-mention-id';
/** The chip's look, shared with the rendered comments' mentions. */
export const MENTION_CHIP_CLASS =
  'inline rounded-full bg-selected px-1.5 py-px font-medium whitespace-nowrap text-primary';
/** A trailing `<br>` that only makes a final empty line visible. */
const FILLER = 'data-filler';

export function chipElement(doc: Document, person: { id: string; name: string }): HTMLElement {
  const el = doc.createElement('span');
  el.setAttribute('contenteditable', 'false');
  el.setAttribute(CHIP_ATTR, person.id);
  el.setAttribute('data-testid', 'mention-chip');
  el.className = MENTION_CHIP_CLASS;
  el.textContent = `@${person.name}`;
  return el;
}

const isChip = (n: Node | null | undefined): n is HTMLElement =>
  n instanceof Element && n.hasAttribute(CHIP_ATTR);

/** The box's content as segments (adjacent text merged). */
export function readSegments(root: HTMLElement): Segment[] {
  const out: Segment[] = [];
  const text = (t: string) => {
    if (!t) return;
    const last = out.at(-1);
    if (last && !('userId' in last)) last.text += t;
    else out.push({ text: t });
  };
  const walk = (parent: Node) => {
    parent.childNodes.forEach((node, i) => {
      if (node.nodeType === Node.TEXT_NODE) text(node.textContent ?? '');
      else if (isChip(node)) {
        const id = node.getAttribute(CHIP_ATTR) ?? '';
        out.push({ userId: id, name: (node.textContent ?? '').replace(/^@/, '') });
      } else if (node instanceof HTMLBRElement) {
        if (!node.hasAttribute(FILLER)) text('\n');
      } else if (node instanceof HTMLElement) {
        // Lines a browser made despite us (a <div> per line): one newline before each.
        if ((node.tagName === 'DIV' || node.tagName === 'P') && i > 0) text('\n');
        walk(node);
      }
    });
  };
  walk(root);
  return out;
}

/** Shows `segments` in the box (replacing what it held). */
export function renderSegments(root: HTMLElement, segments: readonly Segment[]): void {
  const doc = root.ownerDocument;
  root.replaceChildren(
    ...segments.map((s) =>
      'userId' in s ? chipElement(doc, { id: s.userId, name: s.name }) : doc.createTextNode(s.text)
    )
  );
  tidy(root);
}

/**
 * Merges adjacent text nodes (keeping the caret where it was: not every engine moves a live range
 * on normalize()) and keeps a filler `<br>` only after a final newline.
 */
export function tidy(root: HTMLElement): void {
  const sel = root.ownerDocument.getSelection();
  const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  let caret: { node: Node; offset: number } | null =
    range?.collapsed && root.contains(range.startContainer)
      ? { node: range.startContainer, offset: range.startOffset }
      : null;
  for (const br of root.querySelectorAll(`br[${FILLER}]`)) {
    if (caret?.node === root) {
      const index = Array.prototype.indexOf.call(root.childNodes, br);
      if (index < caret.offset) caret = { node: root, offset: caret.offset - 1 };
    }
    br.remove();
  }
  let node = root.firstChild;
  while (node) {
    const next: ChildNode | null = node.nextSibling;
    if (node.nodeType === Node.TEXT_NODE && !node.textContent) {
      if (caret?.node === node) {
        caret = { node: root, offset: Array.prototype.indexOf.call(root.childNodes, node) };
      }
      node.remove();
    } else if (node.nodeType === Node.TEXT_NODE && next?.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      const length = text.data.length;
      if (caret?.node === next) caret = { node: text, offset: length + caret.offset };
      text.appendData((next as Text).data);
      next.remove();
      continue;
    }
    node = next;
  }
  const last = root.lastChild;
  if (last?.nodeType === Node.TEXT_NODE && (last.textContent ?? '').endsWith('\n')) {
    const br = root.ownerDocument.createElement('br');
    br.setAttribute(FILLER, '');
    root.append(br);
  }
  if (caret && root.contains(caret.node)) placeCaret(root, caret.node, caret.offset);
}

function selectionIn(root: HTMLElement): Selection | null {
  const sel = root.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  return root.contains(range.startContainer) && root.contains(range.endContainer) ? sel : null;
}

/** The text node and offset of a collapsed caret in the box, or null. */
export function caretText(root: HTMLElement): { node: Text; offset: number } | null {
  const sel = selectionIn(root);
  if (!sel?.isCollapsed || !sel.anchorNode) return null;
  const node = sel.anchorNode;
  if (node.nodeType === Node.TEXT_NODE) return { node: node as Text, offset: sel.anchorOffset };
  return null;
}

function placeCaret(root: HTMLElement, node: Node, offset: number) {
  const sel = root.ownerDocument.getSelection();
  if (!sel) return;
  const range = root.ownerDocument.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Puts the caret at the end of the box. */
export function caretToEnd(root: HTMLElement): void {
  const filler = root.querySelector(`br[${FILLER}]`);
  const index = filler
    ? Array.prototype.indexOf.call(root.childNodes, filler)
    : root.childNodes.length;
  placeCaret(root, root, index);
}

/** Inserts text at the caret (replacing a selection), the caret after it. */
export function insertText(root: HTMLElement, text: string): void {
  const sel = selectionIn(root);
  const node = root.ownerDocument.createTextNode(text);
  if (sel) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(node);
  } else {
    root.append(node);
  }
  placeCaret(root, node, text.length);
  tidy(root);
}

/**
 * Replaces `node`'s characters `start`..`end` (the typed `@query`) with a chip for `person` and a
 * space, the caret after the space.
 */
export function replaceWithChip(
  root: HTMLElement,
  node: Text,
  start: number,
  end: number,
  person: { id: string; name: string }
): void {
  const doc = root.ownerDocument;
  const after = node.splitText(end);
  node.deleteData(start, end - start);
  const chip = chipElement(doc, person);
  const space = doc.createTextNode(' ');
  node.parentNode?.insertBefore(chip, after);
  node.parentNode?.insertBefore(space, after);
  if (!node.textContent) node.remove();
  placeCaret(root, space, 1);
  tidy(root);
}

/** Backspace right after a chip deletes it whole; true when it did. */
export function deleteChipBeforeCaret(root: HTMLElement): boolean {
  const sel = selectionIn(root);
  if (!sel?.isCollapsed || !sel.anchorNode) return false;
  const { anchorNode: node, anchorOffset: offset } = sel;
  let before: Node | null = null;
  if (node.nodeType === Node.TEXT_NODE) {
    if (offset === 0) before = node.previousSibling;
  } else if (node === root) {
    before = root.childNodes[offset - 1] ?? null;
  }
  if (!isChip(before)) return false;
  const next = before.nextSibling;
  before.remove();
  if (next) placeCaret(root, next, 0);
  else caretToEnd(root);
  tidy(root);
  return true;
}

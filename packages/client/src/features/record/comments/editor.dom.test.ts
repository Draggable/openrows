import { describe, expect, it } from 'vitest';
import {
  caretText,
  deleteChipBeforeCaret,
  insertText,
  readSegments,
  renderSegments,
  replaceWithChip,
} from './editor';

const ADA = '01900000-0000-7000-8000-00000000000a';

function box() {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.replaceChildren(root);
  return root;
}

function caretAt(node: Node, offset: number) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const sel = document.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

describe('composer DOM (#122)', () => {
  it('renders segments as text and chips and reads them back', () => {
    const root = box();
    const segments = [{ text: 'Hi ' }, { userId: ADA, name: 'Ada' }, { text: ' see\n' }];
    renderSegments(root, segments);
    const chip = root.querySelector('[data-mention-id]');
    expect(chip?.textContent).toBe('@Ada');
    expect(chip?.getAttribute('contenteditable')).toBe('false');
    // A final newline gets a filler <br>, which isn't text.
    expect(root.lastChild?.nodeName).toBe('BR');
    expect(readSegments(root)).toEqual(segments);
  });

  it('reads browser-made lines and <br>s as newlines', () => {
    const root = box();
    root.innerHTML = 'one<div>two</div><div>three<br>four</div>';
    expect(readSegments(root)).toEqual([{ text: 'one\ntwo\nthree\nfour' }]);
  });

  it('replaces the typed @query with a chip and a space, caret after it', () => {
    const root = box();
    renderSegments(root, [{ text: 'Ping @ad now' }]);
    const text = root.firstChild as Text;
    caretAt(text, 8);
    replaceWithChip(root, text, 5, 8, { id: ADA, name: 'Ada Lovelace' });
    expect(readSegments(root)).toEqual([
      { text: 'Ping ' },
      { userId: ADA, name: 'Ada Lovelace' },
      { text: '  now' },
    ]);
    insertText(root, 'x');
    expect(readSegments(root)).toEqual([
      { text: 'Ping ' },
      { userId: ADA, name: 'Ada Lovelace' },
      { text: ' x now' },
    ]);
    expect(caretText(root)?.offset).toBe(2);
  });

  it('deletes a chip whole with Backspace right after it', () => {
    const root = box();
    renderSegments(root, [{ text: 'a ' }, { userId: ADA, name: 'Ada' }, { text: 'b' }]);
    const after = root.childNodes[2] as Text;
    caretAt(after, 1);
    expect(deleteChipBeforeCaret(root)).toBe(false);
    caretAt(after, 0);
    expect(deleteChipBeforeCaret(root)).toBe(true);
    expect(readSegments(root)).toEqual([{ text: 'a b' }]);
  });
});

import {
  BARCODE_TYPES,
  type BarcodeType,
  type BarcodeValue,
  guessBarcodeType,
  isValidBarcode,
} from '@openrows/shared';
import { useState } from 'react';
import { type CellEditorProps, type EditorMove, EditorPopover, tabMove, useOnce } from './editors';
import { BARCODE_TYPE_LABELS } from './model';

function readValue(value: unknown): BarcodeValue | null {
  if (typeof value !== 'object' || value === null || !('text' in value)) return null;
  const v = value as { text?: unknown; type?: unknown };
  return typeof v.text === 'string' && typeof v.type === 'string'
    ? { text: v.text, type: v.type as BarcodeType }
    : null;
}

/**
 * The barcode editor: the code's text and its symbology. "Detect" picks the type a scanner
 * would report; a value that isn't valid for the chosen type (a wrong check digit, say) says so
 * and isn't saved. Camera scanning comes with mobile.
 */
export function BarcodeEditor({ field, value, initialText, onCommit, onCancel }: CellEditorProps) {
  const current = readValue(value);
  const [text, setText] = useState(initialText ?? current?.text ?? '');
  const [type, setType] = useState<BarcodeType | 'auto'>(
    initialText !== undefined ? 'auto' : (current?.type ?? 'auto')
  );
  const once = useOnce();
  const trimmed = text.trim();
  const resolved = type === 'auto' ? guessBarcodeType(trimmed) : type;
  const valid = trimmed === '' || (resolved !== null && isValidBarcode(trimmed, resolved));
  const commit = (move: EditorMove) =>
    once(() => {
      if (trimmed === '') return onCommit({ value: null }, move);
      if (!valid || !resolved) {
        return onCommit({ error: `"${trimmed}" isn't a valid barcode of this type` }, move);
      }
      onCommit({ value: { text: trimmed, type: resolved } }, move);
    });
  const errorId = `barcode-${field.id}-error`;
  return (
    <EditorPopover
      label={field.name}
      width={300}
      onOutside={() => commit('away')}
      onEscape={() => once(onCancel)}
    >
      <div className="flex flex-col gap-2">
        <input
          // biome-ignore lint/a11y/noAutofocus: the editor opens on purpose
          autoFocus
          aria-label={field.name}
          aria-invalid={!valid || undefined}
          aria-describedby={valid ? undefined : errorId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit('stay');
            } else if (e.key === 'Tab') {
              e.preventDefault();
              commit(tabMove(e));
            }
          }}
          className="h-8 w-full rounded-sm border border-border bg-surface px-2 font-mono outline-none focus:border-brand aria-[invalid]:border-danger"
        />
        <label className="flex items-center gap-2 text-small text-text-2">
          Type
          <select
            value={type}
            onChange={(e) => setType(e.target.value as BarcodeType | 'auto')}
            className="h-7 flex-1 rounded-sm border border-border bg-surface px-1.5 text-body text-text"
          >
            <option value="auto">
              Detect{type === 'auto' && resolved ? ` (${BARCODE_TYPE_LABELS[resolved]})` : ''}
            </option>
            {BARCODE_TYPES.map((t) => (
              <option key={t} value={t}>
                {BARCODE_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        {!valid && (
          <p id={errorId} role="alert" className="text-small text-danger">
            Not a valid {resolved ? BARCODE_TYPE_LABELS[resolved] : 'barcode'} value
          </p>
        )}
      </div>
    </EditorPopover>
  );
}

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  closeCompletion,
  completionStatus,
} from '@codemirror/autocomplete';
import { history, historyKeymap, standardKeymap } from '@codemirror/commands';
import { type Diagnostic, setDiagnostics } from '@codemirror/lint';
import { EditorState, Prec, RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  placeholder,
  tooltips,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import {
  type FieldMeta,
  FORMULA_FUNCTIONS,
  getFieldType,
  isFieldTypeName,
  tokenize,
} from '@openrows/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { recordQueries } from '../../../api/queries';
import { cn } from '../../../lib/utils';
import {
  analyzeFormula,
  completionSpot,
  errorRange,
  errorSnippet,
  FUNCTION_NAMES,
  fieldReference,
  formulaFields,
  previewFormula,
  RESULT_TYPE_LABELS,
  signatureAt,
  signatureParams,
} from './model';

// The formula editor (DESIGN.md: mono for formulas): CodeMirror 6 with highlighting from the
// shared lexer, completion of fields (by name, stored by id on save) and every function of the
// library with its signature and description, signature help for the call under the cursor,
// inline errors at the type checker's ranges, the result type and the result for the first record.

const mark = (cls: string) => Decoration.mark({ class: cls });
const MARKS = {
  field: mark('cm-formula-field'),
  function: mark('cm-formula-function'),
  string: mark('cm-formula-string'),
  number: mark('cm-formula-number'),
  operator: mark('cm-formula-operator'),
};

/** Token classes from the shared lexer (up to the first lexical error). */
function highlight(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { tokens } = tokenize(view.state.doc.toString());
  tokens.forEach((t, i) => {
    if (t.range.end <= t.range.start) return;
    let m: Decoration | null = null;
    if (t.kind === 'reference') m = MARKS.field;
    else if (t.kind === 'string') m = MARKS.string;
    else if (t.kind === 'number') m = MARKS.number;
    else if (t.kind === 'operator') m = MARKS.operator;
    else if (t.kind === 'identifier') {
      const isCall = tokens[i + 1]?.kind === '(';
      const upper = t.text.toUpperCase();
      m = isCall || upper === 'TRUE' || upper === 'FALSE' ? MARKS.function : MARKS.field;
    }
    if (m) builder.add(t.range.start, t.range.end, m);
  });
  return builder.finish();
}

const highlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = highlight(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = highlight(update.view);
    }
  },
  { decorations: (v) => v.decorations }
);

const theme = EditorView.theme({
  '&': {
    border: '1px solid var(--border)',
    borderRadius: '6px',
    background: 'var(--bg-surface)',
    color: 'var(--text)',
    fontSize: '12.5px',
  },
  '&:hover': { borderColor: 'var(--border-strong)' },
  // The app's focus ring (index.css) on the whole editor rather than its content element.
  '&.cm-focused': {
    outline: 'none',
    boxShadow: '0 0 0 2px var(--bg-surface), 0 0 0 4px var(--brand)',
  },
  '.cm-scroller': {
    fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: '20px',
    maxHeight: '180px',
  },
  '.cm-content': { padding: '6px 0', minHeight: '60px', caretColor: 'var(--text)' },
  '.cm-content:focus-visible': { boxShadow: 'none' },
  '.cm-line': { padding: '0 10px' },
  '.cm-placeholder': { color: 'var(--text-3)' },
  '.cm-formula-field': {
    color: 'var(--chip-blue-text)',
    background: 'var(--chip-blue-bg)',
    borderRadius: '3px',
  },
  '.cm-formula-function': { fontWeight: '600' },
  '.cm-formula-string': { color: 'var(--chip-brown-text)' },
  '.cm-formula-number': { color: 'var(--chip-violet-text)' },
  '.cm-formula-operator': { color: 'var(--text-2)' },
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--danger)',
    textUnderlineOffset: '3px',
  },
  '.cm-lintPoint-error:after': { borderBottomColor: 'var(--danger)' },
  '.cm-tooltip': {
    border: '1px solid var(--border)',
    borderRadius: '6px',
    background: 'var(--bg-surface)',
    color: 'var(--text)',
    boxShadow: 'var(--sh-2)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'inherit',
    maxHeight: '220px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px', lineHeight: '20px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    background: 'var(--bg-selected)',
    color: 'var(--text)',
  },
  '.cm-completionDetail': { color: 'var(--text-2)', fontStyle: 'normal', marginLeft: '8px' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600' },
  '.cm-completionSection': {
    color: 'var(--text-2)',
    fontSize: '11px',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    borderBottom: 'none',
    padding: '4px 8px 2px',
  },
  '.cm-tooltip.cm-completionInfo': { padding: '6px 8px', maxWidth: '260px', fontSize: '12px' },
  '.cm-diagnostic-error': { borderLeft: 'none', color: 'var(--danger)' },
});

const FUNCTION_SECTION = { name: 'Functions', rank: 1 };
const FIELD_SECTION = { name: 'Fields', rank: 0 };

export function FormulaEditor({
  value,
  onChange,
  fields,
  fieldId,
  tableId,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  /** The table's live fields. */
  fields: readonly FieldMeta[];
  /** The edited field (left out of the completions); absent for a new field. */
  fieldId?: string;
  tableId: string;
  /** The field's options, to format the preview like its cells. */
  options: Record<string, unknown>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [cursor, setCursor] = useState(value.length);
  const ids = { label: useId(), help: useId(), errors: useId() };
  const infos = useMemo(() => formulaFields(fields, fieldId), [fields, fieldId]);
  const analysis = useMemo(() => analyzeFormula(value, infos), [value, infos]);
  // The latest props, for CodeMirror's callbacks (created once).
  const latest = useRef({ onChange, infos });
  latest.current = { onChange, infos };

  // The editor is created once; later props reach it through `latest` and the effects below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: created once
  useEffect(() => {
    if (!host.current) return;
    const complete = (context: CompletionContext) => {
      const doc = context.state.doc.toString();
      const spot = completionSpot(doc, context.pos, context.explicit);
      if (!spot) return null;
      const replace =
        (insert: string, caret = insert.length) =>
        (v: EditorView) =>
          v.dispatch({
            changes: {
              from: spot.from,
              to: Math.max(spot.to, v.state.selection.main.head),
              insert,
            },
            selection: { anchor: spot.from + caret },
            userEvent: 'input.complete',
          });
      const fieldOptions: Completion[] = latest.current.infos.map((f) => {
        const ref = fieldReference(f.name);
        return {
          label: spot.kind === 'field' ? ref : f.name,
          displayLabel: f.name,
          detail: isFieldTypeName(f.type) ? getFieldType(f.type).label : f.type,
          type: 'variable',
          section: FIELD_SECTION,
          apply: replace(ref),
        };
      });
      if (spot.kind === 'field') return { from: spot.from, options: fieldOptions };
      const nextIsParen = doc.charAt(spot.to) === '(';
      const functionOptions: Completion[] = FUNCTION_NAMES.map((name) => {
        const sig = FORMULA_FUNCTIONS[name];
        return {
          label: name,
          detail: sig ? `(${signatureParams(sig).join(', ')})` : '',
          info: sig?.description ?? '',
          type: 'function',
          section: FUNCTION_SECTION,
          apply: nextIsParen ? replace(name) : replace(`${name}()`, name.length + 1),
        };
      });
      return { from: spot.from, options: [...fieldOptions, ...functionOptions] };
    };
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          // Ctrl/⌘ Enter saves the field (the form handles it): no newline here.
          Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => true }])),
          keymap.of([...standardKeymap, ...historyKeymap]),
          autocompletion({
            override: [complete],
            icons: false,
            // Enter right after the list opens accepts (a formula rarely wants a newline).
            interactionDelay: 0,
          }),
          // Tooltips (completions and their docs) stay inside the popover around the editor.
          tooltips({
            tooltipSpace: (v) =>
              v.dom.closest('[role="dialog"]')?.getBoundingClientRect() ?? {
                top: 0,
                left: 0,
                right: window.innerWidth,
                bottom: window.innerHeight,
              },
          }),
          highlighter,
          placeholder('For example: {Price} * {Quantity}'),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            'aria-labelledby': ids.label,
            'aria-describedby': `${ids.help} ${ids.errors}`,
            spellcheck: 'false',
            autocapitalize: 'off',
            autocorrect: 'off',
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString());
            if (u.docChanged || u.selectionSet) setCursor(u.state.selection.main.head);
          }),
          theme,
        ],
        selection: { anchor: value.length },
      }),
    });
    view.current = editor;
    // Escape with the completion list open closes the list, not the popover around the editor:
    // Radix listens on the document in the capture phase, before CodeMirror sees the key, so
    // this listener sits on the window, which comes first.
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !editor.hasFocus || completionStatus(editor.state) === null) return;
      closeCompletion(editor);
      e.preventDefault();
    };
    window.addEventListener('keydown', onEscape, { capture: true });
    return () => {
      window.removeEventListener('keydown', onEscape, { capture: true });
      editor.destroy();
      view.current = null;
    };
  }, []);

  // A value set from outside (not typed here) replaces the text.
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === value) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  // Inline errors at the checker's ranges.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const length = v.state.doc.length;
    const diagnostics: Diagnostic[] =
      value.trim() === ''
        ? []
        : analysis.errors.map((e) => ({
            ...errorRange(e, length),
            severity: 'error',
            message: e.message,
          }));
    v.dispatch(setDiagnostics(v.state, diagnostics));
  }, [analysis, value]);

  const help = signatureAt(value, cursor);
  const sample = useQuery({
    ...recordQueries.query(tableId, { limit: 1 }),
    enabled: analysis.ok,
  });
  const first = sample.data?.records[0];
  const preview =
    analysis.ok && first ? previewFormula(analysis.ast, fields, first, options) : null;
  const showErrors = value.trim() !== '' && analysis.errors.length > 0;

  return (
    <div className="grid gap-1.5">
      <span id={ids.label} className="text-small text-text-2">
        Formula
      </span>
      <div ref={host} data-testid="formula-editor" aria-invalid={showErrors ? true : undefined} />
      <p id={ids.help} aria-live="polite" className="min-h-4 text-small text-text-2">
        {help ? (
          <>
            <span className="font-mono text-text">
              {help.name}(
              {help.params.map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: parameters are positional
                <span key={i}>
                  {i > 0 && ', '}
                  <span className={cn(i === help.active && 'font-semibold underline')}>{p}</span>
                </span>
              ))}
              )
            </span>{' '}
            {help.signature.description}
          </>
        ) : (
          <>
            Type <kbd className="rounded-xs border border-border px-1">{'{'}</kbd> for a field, or{' '}
            <kbd className="rounded-xs border border-border px-1">Ctrl</kbd>{' '}
            <kbd className="rounded-xs border border-border px-1">Space</kbd> for suggestions.
          </>
        )}
      </p>
      <div id={ids.errors}>
        {showErrors && (
          <ul aria-label="Formula errors" className="grid gap-0.5 text-small text-danger">
            {analysis.errors.map((e) => (
              <li key={`${e.code}-${e.range.start}-${e.range.end}`}>
                {e.message} <span className="text-text-2">({errorSnippet(e, value)})</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {analysis.ok && (
        <dl
          aria-label="Formula preview"
          className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-sm border border-border bg-header px-2.5 py-1.5 text-small"
        >
          <dt className="text-text-2">Result type</dt>
          <dd className="text-text">{RESULT_TYPE_LABELS[analysis.type]}</dd>
          <dt className="text-text-2">First record</dt>
          <dd className="truncate text-text" data-testid="formula-preview">
            {sample.isPending
              ? 'Computing…'
              : !first
                ? 'No records yet'
                : preview?.ok
                  ? preview.text || 'Empty'
                  : `#ERROR! ${preview?.message ?? ''}`}
          </dd>
        </dl>
      )}
    </div>
  );
}

/** FieldOptions loads the editor lazily: CodeMirror and the evaluator are a separate chunk. */
export default FormulaEditor;

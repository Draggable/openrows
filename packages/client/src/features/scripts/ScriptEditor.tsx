import {
  autocompletion,
  type CompletionContext,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { history, historyKeymap, indentWithTab, standardKeymap } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { useEffect, useRef } from 'react';
import type { HostTable } from './host';
import { scriptCompletions } from './model';

const theme = EditorView.theme({
  '&': {
    height: '100%',
    background: 'var(--bg-surface)',
    color: 'var(--text)',
    fontSize: '12.5px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: '1.6',
  },
  '.cm-gutters': {
    background: 'var(--bg-surface)',
    color: 'var(--text-3)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine': { background: 'var(--bg-hover)' },
  '.cm-content': { caretColor: 'var(--text)' },
  '.cm-tooltip': {
    border: '1px solid var(--border)',
    background: 'var(--bg-surface)',
    borderRadius: '6px',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    background: 'var(--bg-selected)',
    color: 'var(--text)',
  },
});

/**
 * The Scripts page's code editor: CodeMirror with line numbers, history, Tab to indent
 * (Escape then Tab leaves the editor) and completions of the script API and the base's names.
 * Read-only for editors, who run scripts but don't change them.
 */
export function ScriptEditor({
  value,
  onChange,
  tables,
  readOnly,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  tables: HostTable[];
  readOnly: boolean;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ onChange, tables });
  latest.current = { onChange, tables };

  // biome-ignore lint/correctness/useExhaustiveDependencies: built once per script and mode; `value` syncs below.
  useEffect(() => {
    if (!host.current) return;
    const complete = (ctx: CompletionContext) => {
      const line = ctx.state.doc.lineAt(ctx.pos);
      const before = line.text.slice(0, ctx.pos - line.from);
      const result = scriptCompletions(before, latest.current.tables);
      if (!result) return null;
      // Nothing typed yet: open only after `.`, a quote or Ctrl+Space.
      if (result.from === before.length && !ctx.explicit && !/['"`.]$/.test(before)) return null;
      return {
        from: line.from + result.from,
        options: result.options.map((o) => ({
          label: o.label,
          detail: o.detail,
          info: o.info || undefined,
          type: o.type,
          ...(o.apply ? { apply: o.apply } : {}),
        })),
        validFor: /^[\w$ ]*$/,
      };
    };
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          closeBrackets(),
          autocompletion({ override: [complete], icons: false }),
          keymap.of([
            ...closeBracketsKeymap,
            ...completionKeymap,
            indentWithTab,
            ...standardKeymap,
            ...historyKeymap,
          ]),
          EditorState.tabSize.of(2),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.contentAttributes.of({
            'aria-label': label,
            'aria-multiline': 'true',
            role: 'textbox',
            spellcheck: 'false',
            autocapitalize: 'off',
            autocorrect: 'off',
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange(u.state.doc.toString());
          }),
          theme,
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [readOnly, label]);

  // Another script picked, or a saved copy came back: replace the document.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current !== value) {
      editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" data-testid="script-editor" />;
}

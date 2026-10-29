import {
  type FieldMeta,
  type FormField,
  type FormLayout,
  publicFormFieldProblem,
  type TableMeta,
  type UserRole,
  type ViewMeta,
} from '@openrows/shared';
import { EyeOff, GitBranch, GripVertical, Plus, X } from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../../api/client';
import { useUpdateView } from '../../../api/queries';
import { Button, toast } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { FIELD_TYPE_ICONS } from '../../fields/icons';
import { canConfigureView } from '../access';
import { FormPreview } from './FormPreview';
import { FieldSettings, FormSettings } from './FormSettings';
import {
  addableFields,
  addField,
  formEntries,
  labelOf,
  moveField,
  moveProblem,
  removeField,
} from './model';

const SAVE_DELAY = 400;

/**
 * Saves form patches: the builder shows each change at once (`local`), and the patches
 * of the next 400 ms go to the server together (text is typed letter by letter). A refused
 * patch is undone locally with the server's reason.
 */
function useFormLayout(table: TableMeta, view: ViewMeta | undefined, canConfigure: boolean) {
  const updateView = useUpdateView(table.id);
  const [local, setLocal] = useState<FormLayout>({});
  const pending = useRef<FormLayout>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewId = view?.id;
  const { mutate } = updateView;

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const patch = pending.current;
    pending.current = {};
    if (!viewId || Object.keys(patch).length === 0) return;
    mutate(
      { viewId, form: patch },
      {
        onError: (err) => {
          setLocal((l) => {
            const next = { ...l };
            for (const key of Object.keys(patch)) delete next[key as keyof FormLayout];
            return next;
          });
          toast.error(err instanceof ApiError ? err.message : "Couldn't save the form");
        },
      }
    );
  }, [mutate, viewId]);

  useEffect(() => flush, [flush]);

  const save = (patch: FormLayout) => {
    setLocal((l) => ({ ...l, ...patch }));
    if (!canConfigure) return;
    pending.current = { ...pending.current, ...patch };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DELAY);
  };
  return { layout: { ...view?.config.form, ...local } as FormLayout, save };
}

/**
 * The form view's builder: the form's fields on the left (reorder by dragging or
 * Alt+↑/↓, add, remove; a field's label, help text, required, prefill and conditions open
 * under it), the form's settings on a second tab, and a live preview on the right. Read-only
 * roles and locked views get the preview with the settings disabled.
 */
export function FormView({
  table,
  view,
  role,
}: {
  table: TableMeta;
  view: ViewMeta | undefined;
  viewId: string;
  role: UserRole | undefined;
  expandedRecordId?: string | undefined;
  onExpandRecord: (recordId: string | null) => void;
}) {
  const canConfigure = canConfigureView(role, view);
  const fields = useMemo(() => table.fields.filter((f) => !f.deletedAt), [table.fields]);
  const { layout, save } = useFormLayout(table, view, canConfigure);
  const [tab, setTab] = useState<'fields' | 'settings'>('fields');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div className="flex min-h-0 flex-1 max-md:flex-col">
      <aside
        aria-label="Form builder"
        className="flex w-[340px] shrink-0 flex-col border-r border-border bg-surface max-md:max-h-[50vh] max-md:w-full max-md:border-r-0 max-md:border-b"
      >
        <div
          role="tablist"
          aria-label="Form builder"
          className="flex gap-4 border-b border-border px-4"
        >
          {(['fields', 'settings'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`form-tab-${t}`}
              aria-selected={tab === t}
              aria-controls={`form-panel-${t}`}
              onClick={() => setTab(t)}
              className={cn(
                '-mb-px h-10 border-b-2 border-transparent font-[550] text-text-2 hover:text-text',
                tab === t && 'border-primary text-text'
              )}
            >
              {t === 'fields' ? 'Fields' : 'Settings'}
            </button>
          ))}
        </div>
        {!canConfigure && (
          <p className="border-b border-border bg-app px-4 py-2 text-small text-text-2">
            {view?.locked
              ? 'This form is locked. Only creators and owners can change it.'
              : "You can preview this form, but your role can't change it."}
          </p>
        )}
        <div
          role="tabpanel"
          id={`form-panel-${tab}`}
          aria-labelledby={`form-tab-${tab}`}
          className="min-h-0 flex-1 overflow-y-auto p-3"
        >
          {tab === 'fields' ? (
            <FieldList
              layout={layout}
              fields={fields}
              disabled={!canConfigure}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onChange={(list) => save({ fields: list })}
            />
          ) : (
            <FormSettings
              layout={layout}
              tableId={table.id}
              viewId={view?.id}
              fallbackTitle={view?.name ?? 'Form'}
              disabled={!canConfigure}
              onChange={save}
            />
          )}
        </div>
      </aside>
      <FormPreview
        layout={layout}
        fields={fields}
        tableId={table.id}
        fallbackTitle={view?.name ?? 'Form'}
        selectedId={selectedId}
        onSelect={(id) => {
          setTab('fields');
          setSelectedId(id);
        }}
      />
    </div>
  );
}

function FieldList({
  layout,
  fields,
  disabled,
  selectedId,
  onSelect,
  onChange,
}: {
  layout: FormLayout;
  fields: readonly FieldMeta[];
  disabled: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (list: FormField[]) => void;
}) {
  const entries = formEntries(layout, fields);
  const list = entries.map((e) => e.entry);
  const addable = addableFields(layout, fields);
  const listRef = useRef<HTMLUListElement>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const nameOf = (fieldId: string) => {
    const e = entries.find((x) => x.field.id === fieldId);
    return e ? labelOf(e.entry, e.field) : 'A field';
  };

  const move = (from: number, to: number) => {
    if (disabled || to < 0 || to >= list.length || from === to) return;
    const problem = moveProblem(list, from, to, nameOf);
    if (problem) {
      toast.error(problem);
      return;
    }
    const id = list[from]?.fieldId;
    onChange(moveField(list, from, to));
    // The moved row's button keeps the focus.
    requestAnimationFrame(() =>
      listRef.current
        ?.querySelector<HTMLElement>(`[data-form-field="${id}"] [data-field-button]`)
        ?.focus()
    );
  };
  const onKey = (e: KeyboardEvent, index: number) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    move(index, e.key === 'ArrowUp' ? index - 1 : index + 1);
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h3 className="px-1 text-caps font-semibold uppercase tracking-[0.06em] text-text-2">
          On the form ({entries.length})
        </h3>
        {entries.length === 0 && (
          <p className="px-1 text-small text-text-2">No fields yet. Add them below.</p>
        )}
        <ul ref={listRef} aria-label="Form fields" className="grid gap-0.5">
          {entries.map(({ entry, field }, i) => {
            const Icon = FIELD_TYPE_ICONS[field.type as keyof typeof FIELD_TYPE_ICONS];
            const label = labelOf(entry, field);
            const open = selectedId === field.id;
            return (
              <li
                key={field.id}
                data-form-field={field.id}
                draggable={!disabled}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', field.id);
                  setDragFrom(i);
                }}
                onDragOver={(e) => {
                  if (dragFrom === null) return;
                  e.preventDefault();
                  setDragOver(i);
                }}
                onDragEnd={() => {
                  setDragFrom(null);
                  setDragOver(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom !== null) move(dragFrom, i);
                  setDragFrom(null);
                  setDragOver(null);
                }}
                className={cn(
                  'rounded-sm',
                  dragOver === i && dragFrom !== i && 'outline-2 outline-dashed outline-primary',
                  open && 'bg-app'
                )}
              >
                <div
                  className={cn(
                    'group flex h-8 items-center gap-1 rounded-sm pr-1 hover:bg-hover',
                    open && 'bg-selected hover:bg-selected'
                  )}
                >
                  <GripVertical
                    className={cn(
                      'size-4 shrink-0 text-text-3',
                      !disabled && 'cursor-grab active:cursor-grabbing'
                    )}
                    aria-hidden
                  />
                  <button
                    type="button"
                    data-field-button
                    aria-expanded={open}
                    aria-keyshortcuts={disabled ? undefined : 'Alt+ArrowUp Alt+ArrowDown'}
                    title={disabled ? undefined : 'Alt+↑/↓ to move'}
                    onClick={() => onSelect(open ? null : field.id)}
                    onKeyDown={(e) => onKey(e, i)}
                    className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-sm px-1 text-left outline-none focus-visible:outline-2 focus-visible:outline-brand"
                  >
                    {Icon && <Icon className="size-4 shrink-0 text-text-2" aria-hidden />}
                    <span className="truncate">{label}</span>
                    {entry.required && (
                      <span className="text-danger" title="Required">
                        *<span className="sr-only"> required</span>
                      </span>
                    )}
                    {publicFormFieldProblem(field, entry) && (
                      <EyeOff
                        className="ml-auto size-3.5 shrink-0 text-text-2"
                        aria-label="Not on the public form"
                      />
                    )}
                    {entry.condition && entry.condition.conditions.length > 0 && (
                      <GitBranch
                        className={cn(
                          'size-3.5 shrink-0 text-text-2',
                          !publicFormFieldProblem(field, entry) && 'ml-auto'
                        )}
                        aria-label="Shown on conditions"
                      />
                    )}
                  </button>
                  {!disabled && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${label} from the form`}
                      onClick={() => {
                        if (open) onSelect(null);
                        onChange(removeField(list, i, fields));
                      }}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                    >
                      <X aria-hidden />
                    </Button>
                  )}
                </div>
                {open && (
                  <FieldSettings
                    entry={entry}
                    field={field}
                    index={i}
                    list={list}
                    fields={fields}
                    disabled={disabled}
                    onChange={(next) => onChange(list.map((x, j) => (j === i ? next : x)))}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </div>
      {!disabled && addable.length > 0 && (
        <div className="grid gap-1 border-t border-border pt-3">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-caps font-semibold uppercase tracking-[0.06em] text-text-2">
              Add a field
            </h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange(addable.reduce((l, f) => addField(l, f.id), list))}
            >
              Add all
            </Button>
          </div>
          <ul aria-label="Fields to add" className="grid gap-0.5">
            {addable.map((f) => {
              const Icon = FIELD_TYPE_ICONS[f.type as keyof typeof FIELD_TYPE_ICONS];
              return (
                <li key={f.id}>
                  <button
                    type="button"
                    aria-label={`Add ${f.name}`}
                    onClick={() => onChange(addField(list, f.id))}
                    className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-text-2 outline-none hover:bg-hover hover:text-text focus-visible:outline-2 focus-visible:outline-brand"
                  >
                    <Plus className="size-4 shrink-0" aria-hidden />
                    {Icon && <Icon className="size-4 shrink-0" aria-hidden />}
                    <span className="truncate">{f.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <p className="px-1 text-small text-text-2">
        Computed, automatic and button fields can't be on a form.
      </p>
    </div>
  );
}

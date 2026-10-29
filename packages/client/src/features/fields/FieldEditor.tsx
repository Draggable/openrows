import {
  type Choice,
  displayAiPrompt,
  type FieldMeta,
  type FieldTypeName,
  getFieldType,
  storeAiPrompt,
} from '@openrows/shared';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useId, useState } from 'react';
import { ApiError } from '../../api/client';
import { useCreateField, useUpdateField } from '../../api/queries';
import { Button, Input } from '../../components/ui';
import { useAiFieldsAvailable } from '../ai-fields/useAiFieldsAvailable';
import { ConversionPreview } from './ConversionPreview';
import { FieldOptions } from './FieldOptions';
import { analyzeFormula, displayFormula, formulaFields } from './formula-editor/model';
import { FIELD_TYPE_ICONS } from './icons';
import {
  cleanChoices,
  missingComputedOption,
  nameTaken,
  optionsForType,
  parseOptions,
  problemMessages,
  sameOptions,
} from './model';
import { TypePicker } from './TypePicker';

/**
 * For the popover around the editor (`onOpenAutoFocus`): focus the control the editor asked
 * for (`data-autofocus`) rather than the popover's first one.
 */
export function focusRequested(e: Event) {
  const container = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
  const el = container?.querySelector<HTMLElement>('[data-autofocus]');
  if (!el) return;
  e.preventDefault();
  el.focus();
}

export type FieldEditorTarget =
  | {
      mode: 'create';
      /** Table position of the new field (insert left/right); last when absent. */
      position?: number;
      /** Seed for duplicates. */
      initial?: { name: string; type: FieldTypeName; options: unknown; description: string };
    }
  | { mode: 'edit'; field: FieldMeta; focus?: 'name' | 'description' | 'type' };

/** Choices trimmed and empty ones dropped, for the options of any type. */
function cleaned(options: Record<string, unknown>): Record<string, unknown> {
  return Array.isArray(options['choices'])
    ? { ...options, choices: cleanChoices(options['choices'] as Choice[]) }
    : options;
}

/**
 * The field config form (DESIGN.md "Field config popover", mockup e): name, type picker, the
 * type's options (select choices, number precision, date formats…), description, and for a
 * change of type or options on an existing field a preview of how its values convert, with a
 * warning when data would be lost. Ctrl/⌘ Enter saves.
 */
export function FieldEditor({
  tableId,
  fields,
  target,
  onDone,
}: {
  tableId: string;
  /** The table's live fields (for name checks). */
  fields: readonly FieldMeta[];
  target: FieldEditorTarget;
  onDone: (field?: FieldMeta) => void;
}) {
  const existing = target.mode === 'edit' ? target.field : null;
  const seed = target.mode === 'create' ? target.initial : undefined;
  const [name, setName] = useState(existing?.name ?? seed?.name ?? '');
  const [type, setType] = useState<FieldTypeName>(existing?.type ?? seed?.type ?? 'singleLineText');
  const infos = formulaFields(fields, existing?.id);
  // A saved formula is in the stored form (fields by id): edit it with the current names.
  const [options, setOptions] = useState<Record<string, unknown>>(() => {
    const parsed = parseOptions(type, existing?.options ?? seed?.options);
    // An AI prompt is stored by field id too: edited with the names.
    if (type === 'ai' && typeof parsed['prompt'] === 'string') {
      return { ...parsed, prompt: displayAiPrompt(parsed['prompt'], fields) };
    }
    return typeof parsed['formula'] === 'string'
      ? { ...parsed, formula: displayFormula(parsed['formula'], infos) }
      : parsed;
  });
  const [description, setDescription] = useState(existing?.description ?? seed?.description ?? '');
  const focus = target.mode === 'edit' ? target.focus : undefined;
  const [showDescription, setShowDescription] = useState(
    description !== '' || focus === 'description'
  );
  const [showPicker, setShowPicker] = useState(!existing || focus === 'type');
  const [error, setError] = useState<string | null>(null);
  const aiAvailable = useAiFieldsAvailable(tableId);
  const create = useCreateField(tableId);
  const update = useUpdateField(tableId);
  const pending = create.isPending || update.isPending;
  const ids = { name: useId(), description: useId(), error: useId() };

  const pickType = (next: FieldTypeName) => {
    setOptions((o) => optionsForType(next, o));
    setType(next);
    setShowPicker(!existing);
  };

  // A formula is saved in its stored form, so it compares with the saved one; an invalid one
  // can't be saved (the editor shows why).
  const formula =
    typeof options['formula'] === 'string' ? analyzeFormula(options['formula'], infos) : null;
  // An AI prompt likewise: fields by id, so an unchanged prompt compares equal.
  const aiPrompt =
    type === 'ai' && typeof options['prompt'] === 'string'
      ? storeAiPrompt(
          options['prompt'],
          fields.filter((f) => f.id !== existing?.id)
        )
      : null;
  const finalOptions =
    formula?.ok === true
      ? { ...cleaned(options), formula: formula.stored }
      : aiPrompt?.ok === true
        ? {
            ...cleaned(options),
            prompt: aiPrompt.prompt,
            referencedFieldIds: aiPrompt.referencedFieldIds,
          }
        : cleaned(options);
  const optionsChanged = existing
    ? type !== existing.type ||
      !sameOptions(finalOptions, parseOptions(existing.type, existing.options))
    : false;

  // The server's 422 lists each problem (a circular reference, a field of another table…).
  const fail = (err: unknown) => {
    if (!(err instanceof ApiError)) return setError("Couldn't save the field");
    const problems = problemMessages(err.data);
    setError(problems.length > 0 ? problems.join(' ') : err.message);
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError('Give the field a name');
    if (nameTaken(trimmed, fields, existing?.id)) {
      return setError(`A field named "${trimmed}" already exists`);
    }
    if (formula && !formula.ok) {
      return setError(formula.errors[0]?.message ?? 'Fix the formula first');
    }
    if (aiPrompt && !aiPrompt.ok) return setError(aiPrompt.message);
    if (!getFieldType(type).optionsSchema.safeParse(finalOptions).success) {
      return setError('Check the options: one of them is invalid');
    }
    const missing = missingComputedOption(type, finalOptions);
    if (missing) return setError(missing);
    setError(null);
    const desc = description.trim();
    if (!existing) {
      create.mutate(
        {
          name: trimmed,
          type,
          options: finalOptions,
          ...(desc ? { description: desc } : {}),
          ...(target.mode === 'create' && target.position !== undefined
            ? { position: target.position }
            : {}),
        },
        { onSuccess: (field) => onDone(field), onError: fail }
      );
      return;
    }
    const body = {
      ...(trimmed !== existing.name ? { name: trimmed } : {}),
      ...(type !== existing.type ? { type } : {}),
      ...(optionsChanged ? { options: finalOptions } : {}),
      ...(desc !== (existing.description ?? '') ? { description: desc || null } : {}),
    };
    if (Object.keys(body).length === 0) return onDone(existing);
    update.mutate({ fieldId: existing.id, ...body }, { onSuccess: onDone, onError: fail });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  };

  const Icon = FIELD_TYPE_ICONS[type];
  return (
    <form
      onSubmit={submit}
      onKeyDown={onKeyDown}
      aria-label={existing ? `Edit field ${existing.name}` : 'New field'}
      className="grid gap-3"
    >
      <div className="grid gap-1">
        <label htmlFor={ids.name} className="text-small text-text-2">
          Field name
        </label>
        <Input
          id={ids.name}
          autoFocus={!focus || focus === 'name'}
          data-autofocus={!focus || focus === 'name' ? '' : undefined}
          onFocus={(e) => existing && e.currentTarget.select()}
          value={name}
          maxLength={255}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? ids.error : undefined}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
        />
      </div>
      <div className="grid gap-1">
        <span className="text-small text-text-2">Field type</span>
        {existing && (
          <button
            type="button"
            aria-expanded={showPicker}
            aria-label={`Field type: ${getFieldType(type).label}`}
            onClick={() => setShowPicker((v) => !v)}
            className="flex h-8 items-center gap-2 rounded-sm border border-border bg-surface px-2.5 text-left text-text hover:border-border-strong"
          >
            <Icon className="size-4 text-text-2" aria-hidden />
            {getFieldType(type).label}
            <ChevronDown className="ml-auto size-4 text-text-3" aria-hidden />
          </button>
        )}
        {showPicker && (
          <TypePicker
            value={type}
            onChange={pickType}
            autoFocus={focus === 'type'}
            exclude={aiAvailable || existing?.type === 'ai' ? [] : ['ai']}
          />
        )}
      </div>
      <FieldOptions
        type={type}
        options={options}
        onChange={setOptions}
        tableId={tableId}
        fields={fields}
        fieldId={existing?.id}
        locked={existing?.type === type && getFieldType(type).storage.kind === 'link'}
      />
      <div className="grid gap-1">
        <button
          type="button"
          aria-expanded={showDescription}
          onClick={() => setShowDescription((v) => !v)}
          className="flex items-center gap-1 justify-self-start text-text hover:text-text-2"
        >
          {showDescription ? (
            <ChevronDown className="size-4" aria-hidden />
          ) : (
            <ChevronRight className="size-4" aria-hidden />
          )}
          Description
        </button>
        {showDescription && (
          <textarea
            id={ids.description}
            aria-label="Description"
            // biome-ignore lint/a11y/noAutofocus: opened by "Edit description"
            autoFocus={focus === 'description'}
            data-autofocus={focus === 'description' ? '' : undefined}
            value={description}
            maxLength={2000}
            rows={3}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this field holds"
            className="w-full resize-y rounded-sm border border-border bg-surface px-2.5 py-1.5 text-body text-text placeholder:text-text-3 hover:border-border-strong"
          />
        )}
      </div>
      {existing && optionsChanged && !(existing.type === type && getFieldType(type).computed) && (
        <ConversionPreview field={existing} type={type} options={finalOptions} />
      )}
      {error && (
        <p id={ids.error} role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2 border-t border-border pt-3">
        <span className="text-small text-text-2">
          <kbd className="rounded-xs border border-border px-1">Ctrl</kbd>{' '}
          <kbd className="rounded-xs border border-border px-1">Enter</kbd> to{' '}
          {existing ? 'save' : 'create'}
        </span>
        <Button type="button" variant="ghost" className="ml-auto" onClick={() => onDone()}>
          Cancel
        </Button>
        <Button type="submit" disabled={!name.trim() || pending || formula?.ok === false}>
          {existing ? 'Save' : 'Create field'}
        </Button>
      </div>
    </form>
  );
}

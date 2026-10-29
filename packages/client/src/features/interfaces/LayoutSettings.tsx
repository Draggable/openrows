import {
  type FieldMeta,
  type InterfacePageConfig,
  isCalendarDateField,
  isInterfaceWritableType,
  MAX_INTERFACE_FORM_FIELDS,
} from '@openrows/shared';
import { useId } from 'react';
import { Input } from '../../components/ui';

const selectClass =
  'h-8 w-full rounded-sm border border-border bg-surface px-2 text-body text-text hover:border-border-strong';

/**
 * a kanban's stack field and card fields,
 * a calendar's and a timeline's dates, a form's fields, required ones and messages.
 */
export function LayoutSettings({
  config,
  fields,
  onChange,
}: {
  config: InterfacePageConfig;
  fields: FieldMeta[];
  onChange: (config: InterfacePageConfig) => void;
}) {
  const ids = { a: useId(), b: useId(), c: useId(), d: useId() };
  const dates = fields.filter((f) => isCalendarDateField(f));
  const choose = (
    list: FieldMeta[],
    value: string | null | undefined,
    set: (v: string | null) => void,
    id: string,
    label: string,
    optional = false
  ) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-small text-text-2">
        {label}
      </label>
      <select
        id={id}
        className={selectClass}
        value={value ?? ''}
        onChange={(e) => set(e.target.value || null)}
      >
        <option value="">{optional ? 'None' : 'Pick a field'}</option>
        {list.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </div>
  );

  if (config.layout === 'kanban') {
    const kanban = config.kanban ?? {};
    const cards = new Set(kanban.cardFields ?? []);
    return (
      <section className="flex flex-col gap-2">
        <h2 className="font-[550]">Kanban</h2>
        {choose(
          fields.filter((f) => f.type === 'singleSelect'),
          kanban.stackFieldId,
          (v) => onChange({ ...config, kanban: { ...kanban, stackFieldId: v } }),
          ids.a,
          'Stack by'
        )}
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-small text-text-2">Fields on cards</legend>
          {fields
            .filter((f) => !f.isPrimary && f.id !== kanban.stackFieldId)
            .map((f) => (
              <label key={f.id} className="flex h-7 items-center gap-2 text-text">
                <input
                  type="checkbox"
                  checked={cards.has(f.id)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...(kanban.cardFields ?? []), f.id]
                      : (kanban.cardFields ?? []).filter((id) => id !== f.id);
                    onChange({ ...config, kanban: { ...kanban, cardFields: next } });
                  }}
                  className="size-4 accent-[var(--accent)]"
                />
                <span className="truncate">{f.name}</span>
              </label>
            ))}
        </fieldset>
      </section>
    );
  }

  if (config.layout === 'calendar') {
    const calendar = config.calendar ?? {};
    const pair = calendar.dateFields?.[0];
    const setPair = (start: string | null, end: string | null) =>
      onChange({
        ...config,
        calendar: {
          ...calendar,
          dateFields: start ? [{ startFieldId: start, ...(end ? { endFieldId: end } : {}) }] : [],
        },
      });
    return (
      <section className="flex flex-col gap-2">
        <h2 className="font-[550]">Calendar</h2>
        {choose(
          dates,
          pair?.startFieldId,
          (v) => setPair(v, pair?.endFieldId ?? null),
          ids.a,
          'Date'
        )}
        {choose(
          dates.filter((f) => f.id !== pair?.startFieldId),
          pair?.endFieldId,
          (v) => setPair(pair?.startFieldId ?? null, v),
          ids.b,
          'End date',
          true
        )}
      </section>
    );
  }

  if (config.layout === 'timeline') {
    const timeline = config.timeline ?? {};
    const set = (patch: Partial<NonNullable<InterfacePageConfig['timeline']>>) =>
      onChange({ ...config, timeline: { ...timeline, ...patch } });
    return (
      <section className="flex flex-col gap-2">
        <h2 className="font-[550]">Timeline</h2>
        {choose(dates, timeline.startFieldId, (v) => set({ startFieldId: v }), ids.a, 'Start')}
        {choose(
          dates.filter((f) => f.id !== timeline.startFieldId),
          timeline.endFieldId,
          (v) => set({ endFieldId: v }),
          ids.b,
          'End',
          true
        )}
        {choose(
          fields.filter((f) => f.type === 'singleSelect'),
          timeline.groupFieldId,
          (v) => set({ groupFieldId: v }),
          ids.c,
          'Group by',
          true
        )}
      </section>
    );
  }

  if (config.layout === 'form') {
    const form = config.form ?? {
      fields: [],
      submitLabel: 'Submit',
      successMessage: 'Thanks, your response was recorded.',
    };
    const byId = new Map(form.fields.map((f) => [f.fieldId, f]));
    const setForm = (patch: Partial<typeof form>) =>
      onChange({ ...config, form: { ...form, ...patch } });
    return (
      <section className="flex flex-col gap-2">
        <h2 className="font-[550]">Form</h2>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-small text-text-2">
            Fields (and whether they're required)
          </legend>
          {fields
            .filter((f) => isInterfaceWritableType(f.type))
            .map((f) => {
              const entry = byId.get(f.id);
              return (
                <div key={f.id} className="flex h-7 items-center gap-2 text-text">
                  <label className="flex min-w-0 flex-1 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={!!entry}
                      disabled={!entry && form.fields.length >= MAX_INTERFACE_FORM_FIELDS}
                      onChange={(e) =>
                        setForm({
                          fields: e.target.checked
                            ? [...form.fields, { fieldId: f.id, label: '', required: false }]
                            : form.fields.filter((x) => x.fieldId !== f.id),
                        })
                      }
                      className="size-4 accent-[var(--accent)]"
                    />
                    <span className="truncate">{f.name}</span>
                  </label>
                  {entry && (
                    <label className="flex items-center gap-1 text-small text-text-2">
                      <input
                        type="checkbox"
                        aria-label={`${f.name} is required`}
                        checked={entry.required}
                        onChange={(e) =>
                          setForm({
                            fields: form.fields.map((x) =>
                              x.fieldId === f.id ? { ...x, required: e.target.checked } : x
                            ),
                          })
                        }
                        className="size-4 accent-[var(--accent)]"
                      />
                      Required
                    </label>
                  )}
                </div>
              );
            })}
        </fieldset>
        <label htmlFor={ids.c} className="text-small text-text-2">
          Submit button
        </label>
        <Input
          id={ids.c}
          value={form.submitLabel}
          maxLength={60}
          onChange={(e) => setForm({ submitLabel: e.target.value })}
        />
        <label htmlFor={ids.d} className="text-small text-text-2">
          Message after submitting
        </label>
        <Input
          id={ids.d}
          value={form.successMessage}
          maxLength={500}
          onChange={(e) => setForm({ successMessage: e.target.value })}
        />
      </section>
    );
  }
  return null;
}

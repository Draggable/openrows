import {
  type FieldMeta,
  INTERFACE_RECORDS_PAGE_MAX,
  type InterfacePageConfig,
  type InterfacePageRecords,
  type SharedRecord,
  type SharedView,
  type TableMeta,
  VIEW_LIKE_LAYOUTS,
} from '@openrows/shared';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2Icon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { ApiError, api } from '../../api/client';
import { queryKeys } from '../../api/keys';
import { interfaceRecordsQuery } from '../../api/queries';
import { Button, Skeleton, toast } from '../../components/ui';
import { cn } from '../../lib/utils';
import { cellText } from '../grid/cells/model';
import { asFieldMeta, SharedCell } from '../share/SharedCell';
import { type LayoutRecordsSource, SharedLayout } from '../share/SharedLayouts';
import { PreviewInput } from '../views/form/FormPreview';
import { Canvas, type DesignerProps, type ElementContext } from './Canvas';
import { dataFilters, type FilterValues } from './model';
import { type PageSource, useDashboardData } from './useDashboardData';

/** The most records a kanban, calendar or timeline page loads (as a shared view does). */
const LAYOUT_MAX_RECORDS = 1000;

/**
 * A page drawn from the interface's own routes: its records come projected to the fields
 * the page shows, filtered on the server for this viewer (`me` is them), so it works the same for
 * interface-only collaborators, who can't read the base. Record lists and reviews, forms, the
 * view-like layouts (kanban, calendar, timeline: the share links' read-only layouts) and
 * dashboards.
 */
export function PageRuntime({
  config,
  pageName,
  source,
  designer,
}: {
  config: InterfacePageConfig;
  pageName: string;
  source: PageSource;
  designer?: DesignerProps | undefined;
}) {
  const [filterValues, setFilterValues] = useState<FilterValues>({});
  const [selected, setSelected] = useState<string | null>(null);
  const filters = dataFilters(filterValues);
  const ids = { interfaceId: source.interfaceId, pageId: source.pageId };
  const viewLike = VIEW_LIKE_LAYOUTS.includes(config.layout);
  const body = { draft: source.draft, filters, ...(viewLike ? { limit: 1 } : {}) };
  const records = useQuery(interfaceRecordsQuery(source.baseId, ids, body));
  const fields = useMemo(
    () => (records.data?.fields ?? []).map(asFieldMeta),
    [records.data?.fields]
  );
  const table = runtimeTable(records.data, fields);
  const dataOf = useDashboardData(source, config, filterValues, fields);

  if (records.isPending) return <Skeleton className="h-10" />;
  if (records.isError || !records.data) {
    return (
      <p className="text-text-2">
        {records.error instanceof ApiError ? records.error.message : "Couldn't load this page."}
      </p>
    );
  }
  const data = records.data;
  const rows = data.records;
  const record = rows.find((r) => r.id === selected) ?? rows[0];
  const primary = fields.find((f) => f.isPrimary);
  const context: ElementContext = {
    table,
    record: record ? { id: record.id, fields: record.fields, version: 0 } : undefined,
    userRole: undefined,
    filterValues,
    onFilterChange: (id, value) => setFilterValues((prev) => ({ ...prev, [id]: value })),
    dataOf,
    noAutomations: true,
    renderField: (element, field) =>
      record ? (
        <RuntimeField
          source={source}
          field={field}
          record={record}
          editable={element.editable && data.editable.includes(field.id) && !designer}
        />
      ) : null,
  };
  const canvas = <Canvas elements={config.elements} context={context} designer={designer} />;
  const count = (
    <p className="text-small text-text-2" role="status">
      {data.total === 1 ? '1 record' : `${data.total.toLocaleString()} records`}
    </p>
  );

  if (config.layout === 'dashboard') {
    return (
      <section aria-label="Dashboard" className="flex flex-col gap-4">
        {canvas}
      </section>
    );
  }

  if (config.layout === 'form') {
    return (
      <div className="flex flex-col gap-4">
        {canvas}
        <InterfaceForm
          config={config}
          fields={fields}
          source={source}
          canSubmit={data.canSubmit && !designer && !source.draft}
        />
      </div>
    );
  }

  if (viewLike) {
    const shared: SharedView = {
      view: { name: pageName, type: config.layout as SharedView['view']['type'] },
      table: { name: data.table.name },
      fields: data.fields,
      layout: {},
      ...(data.kanban ? { kanban: data.kanban } : {}),
      ...(data.calendar ? { calendar: data.calendar } : {}),
      ...(data.timeline ? { timeline: data.timeline } : {}),
      expiresAt: null,
    };
    const layoutSource: LayoutRecordsSource = (window) =>
      queryOptions({
        queryKey: queryKeys.interfaces.records(source.baseId, source.pageId, {
          draft: source.draft,
          filters,
          window,
        }) as readonly unknown[],
        queryFn: async () => {
          const all: SharedRecord[] = [];
          let total = 0;
          while (all.length < LAYOUT_MAX_RECORDS) {
            const page = await api.interfaces.pageRecords({
              params: ids,
              body: {
                draft: source.draft,
                filters,
                offset: all.length,
                limit: Math.min(INTERFACE_RECORDS_PAGE_MAX, LAYOUT_MAX_RECORDS - all.length),
                ...(window ?? {}),
              },
            });
            all.push(...page.records);
            total = page.total;
            if (page.records.length === 0 || all.length >= total) break;
          }
          return { records: all, total };
        },
      });
    return (
      <div className="flex h-full min-h-[420px] flex-col gap-4">
        {config.elements.length > 0 && canvas}
        <div className="flex min-h-[420px] flex-1 flex-col overflow-hidden rounded-md border border-border bg-surface">
          <SharedLayout
            token={null}
            viewId={source.pageId}
            shared={shared}
            records={layoutSource}
          />
        </div>
      </div>
    );
  }

  const columns = [
    ...(primary ? [primary] : []),
    ...config.fields.flatMap((id) => {
      const f = fields.find((x) => x.id === id && !x.isPrimary);
      return f ? [f] : [];
    }),
  ];
  const title = (r: SharedRecord) =>
    (primary && cellText(primary, r.fields[primary.id] ?? null)) || 'Unnamed record';

  if (config.layout === 'recordList') {
    return (
      <div className="flex flex-col gap-4">
        {canvas}
        {count}
        <div className="overflow-x-auto rounded-md border border-border bg-surface">
          <table className="w-full text-body" aria-label={`${data.table.name} records`}>
            <thead>
              <tr className="h-[34px] border-b border-border text-left text-text-2">
                {columns.map((f) => (
                  <th key={f.id} scope="col" className="px-3 font-[550]">
                    {f.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="h-[34px] border-b border-border last:border-0">
                  {columns.map((f) => (
                    <td key={f.id} className="max-w-[320px] truncate px-3">
                      <SharedCell
                        token={null}
                        viewId={source.pageId}
                        field={f}
                        value={r.fields[f.id] ?? null}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 gap-4 max-md:flex-col">
      <section
        aria-label={`${data.table.name} records`}
        className="flex w-72 shrink-0 flex-col gap-2 max-md:w-full"
      >
        {count}
        <ul className="flex flex-col overflow-y-auto rounded-md border border-border bg-surface">
          {rows.map((r) => {
            const active = r.id === record?.id;
            return (
              <li key={r.id} className="border-b border-border last:border-0">
                <button
                  type="button"
                  aria-current={active ? 'true' : undefined}
                  onClick={() => setSelected(r.id)}
                  className={cn(
                    'flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-hover',
                    active && 'bg-selected'
                  )}
                >
                  <span className="w-full truncate font-[550] text-text">{title(r)}</span>
                  {columns.slice(1, 3).map((f) => (
                    <span key={f.id} className="w-full truncate text-small text-text-2">
                      {cellText(f, r.fields[f.id] ?? null)}
                    </span>
                  ))}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      <section aria-label="Selected record" className="min-w-0 flex-1">
        {record && <h2 className="mb-3 truncate text-[17px] font-[550]">{title(record)}</h2>}
        {canvas}
      </section>
    </div>
  );
}

/** The page's table as the elements read it: only the fields the page shows. */
function runtimeTable(data: InterfacePageRecords | undefined, fields: FieldMeta[]): TableMeta {
  return {
    id: data?.table.id ?? '',
    baseId: '',
    name: data?.table.name ?? '',
    description: null,
    icon: null,
    position: 0,
    schemaVersion: 0,
    fields,
    createdAt: '',
    updatedAt: '',
  };
}

/**
 * A field element on a record review page: the value as the page shows it, or (a field the page
 * lets this viewer edit) an input saved through the page's record route.
 */
function RuntimeField({
  source,
  field,
  record,
  editable,
}: {
  source: PageSource;
  field: FieldMeta;
  record: SharedRecord;
  editable: boolean;
}) {
  const id = useId();
  const qc = useQueryClient();
  const value = record.fields[field.id] ?? null;
  const [draft, setDraft] = useState<{ recordId: string; value: unknown } | null>(null);
  const shown = draft?.recordId === record.id ? draft.value : value;
  const save = async (next: unknown) => {
    try {
      await api.interfaces.updatePageRecord({
        params: { interfaceId: source.interfaceId, pageId: source.pageId, recordId: record.id },
        body: { fields: { [field.id]: next } },
      });
      await qc.invalidateQueries({
        queryKey: queryKeys.interfaces.records(source.baseId, source.pageId),
      });
      setDraft(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't save it");
    }
  };
  if (!editable) {
    return (
      <div className="flex flex-col gap-1 px-2">
        <span className="text-small text-text-2">{field.name}</span>
        <div className="flex min-h-8 items-center">
          <SharedCell token={null} viewId={source.pageId} field={field} value={value} />
        </div>
      </div>
    );
  }
  const commitsOnChange = field.type === 'checkbox' || field.type === 'singleSelect';
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-1 border-0 p-0 px-2"
      onBlur={(e) => {
        if (commitsOnChange || e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        if (draft?.recordId === record.id) void save(draft.value);
      }}
    >
      <label htmlFor={id} className="text-small text-text-2">
        {field.name}
      </label>
      <PreviewInput
        id={id}
        field={field}
        value={shown}
        required={false}
        onChange={(next) => {
          setDraft({ recordId: record.id, value: next });
          if (commitsOnChange) void save(next);
        }}
      />
    </fieldset>
  );
}

/** A form page: the form's fields, submitted as a new record through the page. */
function InterfaceForm({
  config,
  fields,
  source,
  canSubmit,
}: {
  config: InterfacePageConfig;
  fields: FieldMeta[];
  source: PageSource;
  canSubmit: boolean;
}) {
  const form = config.form;
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const qc = useQueryClient();
  const entries = (form?.fields ?? []).flatMap((e) => {
    const field = fields.find((f) => f.id === e.fieldId);
    return field ? [{ ...e, field }] : [];
  });
  if (done) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-md border border-border bg-surface p-6">
        <CheckCircle2Icon className="size-6 text-brand" aria-hidden />
        <p role="status">{form?.successMessage || 'Thanks, your response was recorded.'}</p>
        <Button
          variant="secondary"
          onClick={() => {
            setAnswers({});
            setDone(false);
          }}
        >
          Submit another response
        </Button>
      </div>
    );
  }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const blank = (v: unknown) => v === undefined || v === null || v === '';
    const missing = Object.fromEntries(
      entries
        .filter((x) => x.required && blank(answers[x.fieldId]))
        .map((x) => [x.fieldId, 'Required'])
    );
    setErrors(missing);
    if (Object.keys(missing).length > 0) return;
    setSending(true);
    try {
      await api.interfaces.submitPageForm({
        params: { interfaceId: source.interfaceId, pageId: source.pageId },
        body: { fields: answers },
      });
      await qc.invalidateQueries({ queryKey: ['interfaces', source.baseId] });
      setDone(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't submit the form");
    } finally {
      setSending(false);
    }
  };
  return (
    <form
      aria-label="Form"
      noValidate
      onSubmit={submit}
      className="grid max-w-xl gap-5 rounded-md border border-border bg-surface p-6"
    >
      {entries.length === 0 && <p className="text-text-2">This form has no fields yet.</p>}
      {entries.map((entry) => {
        const id = `form-${source.pageId}-${entry.fieldId}`;
        return (
          <div key={entry.fieldId} className="grid gap-1.5">
            <label htmlFor={id} className="font-[550]">
              {entry.label || entry.field.name}
              {entry.required && (
                <span className="ml-0.5 text-danger" aria-hidden>
                  *
                </span>
              )}
              {entry.required && <span className="sr-only"> (required)</span>}
            </label>
            <PreviewInput
              id={id}
              field={entry.field}
              value={answers[entry.fieldId]}
              required={entry.required}
              onChange={(v) => setAnswers((a) => ({ ...a, [entry.fieldId]: v }))}
            />
            {errors[entry.fieldId] && (
              <p className="text-small text-danger">{errors[entry.fieldId]}</p>
            )}
          </div>
        );
      })}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!canSubmit || sending}>
          {sending ? 'Sending…' : form?.submitLabel || 'Submit'}
        </Button>
        {!canSubmit && (
          <span className="text-small text-text-2">
            Submitting is off in the designer and for read-only access.
          </span>
        )}
      </div>
    </form>
  );
}

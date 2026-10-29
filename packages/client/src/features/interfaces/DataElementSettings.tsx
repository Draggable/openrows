import {
  type Aggregate,
  CHART_AGGREGATES,
  CHART_ORDERS,
  CHART_TYPES,
  type ChartAggregate,
  type ChartElement,
  type FieldMeta,
  type NumberElement,
  type TableMeta,
} from '@openrows/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useId } from 'react';
import { tableQueries, useViews } from '../../api/queries';
import { Input, toast } from '../../components/ui';
import { FilterMenu } from '../views/toolbar/FilterMenu';
import { AGGREGATE_LABELS, aggregatesForField, CHART_LABELS, isNumeric } from './chart-model';
import { defaultGroupField } from './model';

const selectClass =
  'h-8 w-full rounded-sm border border-border bg-surface px-2 text-body text-text hover:border-border-strong';

const ORDER_LABELS: Record<ChartElement['order'], string> = {
  field: "The field's order",
  valueDesc: 'Largest first',
  valueAsc: 'Smallest first',
};

function Row({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-small text-text-2">
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * A number's or chart's settings: its title, table and view, what it summarizes (the
 * count of records, or an aggregate of a field), a chart's type, groups, series and order, and
 * its own filter. The server checks them again when the draft is saved.
 */
export function DataElementSettings({
  baseId,
  element,
  pageTable,
  onChange,
}: {
  baseId: string;
  element: NumberElement | ChartElement;
  pageTable: TableMeta;
  onChange: (element: NumberElement | ChartElement) => void;
}) {
  const id = useId();
  const qc = useQueryClient();
  const tables = useQuery(tableQueries.list(baseId));
  const detail = useQuery({
    ...tableQueries.detail(element.tableId),
    enabled: element.tableId !== pageTable.id,
  });
  const table = element.tableId === pageTable.id ? pageTable : detail.data;
  const fields: FieldMeta[] = table?.fields ?? [];
  const views = useViews(element.tableId).data?.views.filter((v) => !v.personal) ?? [];

  const switchTable = async (tableId: string) => {
    try {
      const next = await qc.fetchQuery(tableQueries.detail(tableId));
      const base = { ...element, tableId, viewId: null, filter: undefined, fieldId: null };
      if (element.type === 'number') {
        onChange({ ...base, type: 'number', fn: 'count' });
        return;
      }
      const group = defaultGroupField(next.fields);
      if (!group) {
        toast.error('That table has no field to group by.');
        return;
      }
      onChange({
        ...(base as ChartElement),
        groupFieldId: group.id,
        seriesFieldId: null,
        fn: 'count',
      });
    } catch {
      toast.error("Couldn't load that table");
    }
  };

  const common = (
    <>
      <Row id={`${id}-label`} label="Title">
        <Input
          id={`${id}-label`}
          value={element.label}
          placeholder="Named after what it shows"
          maxLength={100}
          onChange={(e) => onChange({ ...element, label: e.target.value })}
        />
      </Row>
      <Row id={`${id}-table`} label="Table">
        <select
          id={`${id}-table`}
          className={selectClass}
          value={element.tableId}
          onChange={(e) => void switchTable(e.target.value)}
        >
          {(tables.data?.tables ?? [pageTable]).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Row>
      <Row id={`${id}-view`} label="Records">
        <select
          id={`${id}-view`}
          className={selectClass}
          value={element.viewId ?? ''}
          onChange={(e) => onChange({ ...element, viewId: e.target.value || null })}
        >
          <option value="">All records</option>
          {views.map((v) => (
            <option key={v.id} value={v.id}>
              In the view {v.name}
            </option>
          ))}
        </select>
      </Row>
    </>
  );

  const filter = (
    <div className="flex flex-col gap-1.5">
      <span className="text-small text-text-2">Only records matching</span>
      <div>
        <FilterMenu
          fields={fields}
          filter={element.filter ?? { conjunction: 'and', conditions: [] }}
          onChange={(f) =>
            onChange({ ...element, filter: f.conditions.length > 0 ? f : undefined })
          }
        />
      </div>
      {element.tableId === pageTable.id && (
        <p className="text-small text-text-3">
          The page's filter and its filter elements narrow it too.
        </p>
      )}
    </div>
  );

  if (element.type === 'number') {
    const field = fields.find((f) => f.id === element.fieldId);
    return (
      <>
        {common}
        <Row id={`${id}-field`} label="Summarize">
          <select
            id={`${id}-field`}
            className={selectClass}
            value={element.fieldId ?? ''}
            onChange={(e) => {
              const next = fields.find((f) => f.id === e.target.value);
              const fns = aggregatesForField(next);
              onChange({
                ...element,
                fieldId: next?.id ?? null,
                fn: next ? (fns.includes('sum') ? 'sum' : (fns[0] ?? 'filled')) : 'count',
              });
            }}
          >
            <option value="">Count of records</option>
            {fields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </Row>
        {field && (
          <Row id={`${id}-fn`} label="Aggregate">
            <select
              id={`${id}-fn`}
              className={selectClass}
              value={element.fn}
              onChange={(e) => onChange({ ...element, fn: e.target.value as Aggregate })}
            >
              {aggregatesForField(field).map((fn) => (
                <option key={fn} value={fn}>
                  {AGGREGATE_LABELS[fn]}
                </option>
              ))}
            </select>
          </Row>
        )}
        {filter}
      </>
    );
  }

  const numbers = fields.filter(isNumeric);
  const pie = element.chart === 'pie' || element.chart === 'donut';
  return (
    <>
      {common}
      <Row id={`${id}-chart`} label="Chart">
        <select
          id={`${id}-chart`}
          className={selectClass}
          value={element.chart}
          onChange={(e) => {
            const chart = e.target.value as ChartElement['chart'];
            const nextPie = chart === 'pie' || chart === 'donut';
            const series = nextPie
              ? null
              : chart === 'stackedBar' && !element.seriesFieldId
                ? (fields.find((f) => f.type === 'singleSelect' && f.id !== element.groupFieldId)
                    ?.id ??
                  fields.find((f) => f.id !== element.groupFieldId)?.id ??
                  null)
                : element.seriesFieldId;
            onChange({ ...element, chart, seriesFieldId: series });
          }}
        >
          {CHART_TYPES.map((c) => (
            <option key={c} value={c}>
              {CHART_LABELS[c]}
            </option>
          ))}
        </select>
      </Row>
      <Row id={`${id}-group`} label={pie ? 'Slices' : 'Group by (x axis)'}>
        <select
          id={`${id}-group`}
          className={selectClass}
          value={element.groupFieldId}
          onChange={(e) =>
            onChange({
              ...element,
              groupFieldId: e.target.value,
              seriesFieldId:
                element.seriesFieldId === e.target.value ? null : element.seriesFieldId,
            })
          }
        >
          {fields.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </Row>
      {!pie && (
        <Row id={`${id}-series`} label={element.chart === 'stackedBar' ? 'Stack by' : 'Split by'}>
          <select
            id={`${id}-series`}
            className={selectClass}
            value={element.seriesFieldId ?? ''}
            onChange={(e) => onChange({ ...element, seriesFieldId: e.target.value || null })}
          >
            {element.chart !== 'stackedBar' && <option value="">No split</option>}
            {fields
              .filter((f) => f.id !== element.groupFieldId)
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
          </select>
        </Row>
      )}
      <Row id={`${id}-value`} label="Value">
        <select
          id={`${id}-value`}
          className={selectClass}
          value={element.fieldId ?? ''}
          onChange={(e) => {
            const fieldId = e.target.value || null;
            onChange({
              ...element,
              fieldId,
              fn: fieldId ? (element.fn === 'count' ? 'sum' : element.fn) : 'count',
            });
          }}
        >
          <option value="">Count of records</option>
          {numbers.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </Row>
      {element.fieldId && (
        <Row id={`${id}-fn`} label="Aggregate">
          <select
            id={`${id}-fn`}
            className={selectClass}
            value={element.fn}
            onChange={(e) => onChange({ ...element, fn: e.target.value as ChartAggregate })}
          >
            {CHART_AGGREGATES.filter((fn) => fn !== 'count').map((fn) => (
              <option key={fn} value={fn}>
                {AGGREGATE_LABELS[fn]}
              </option>
            ))}
          </select>
        </Row>
      )}
      <Row id={`${id}-order`} label="Order">
        <select
          id={`${id}-order`}
          className={selectClass}
          value={element.order}
          onChange={(e) => onChange({ ...element, order: e.target.value as ChartElement['order'] })}
        >
          {CHART_ORDERS.map((o) => (
            <option key={o} value={o}>
              {ORDER_LABELS[o]}
            </option>
          ))}
        </select>
      </Row>
      {filter}
    </>
  );
}

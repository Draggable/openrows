import {
  type ChartElement,
  type FieldMeta,
  type InterfaceElementData,
  MAX_CHART_GROUPS,
  type NumberElement,
} from '@openrows/shared';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Skeleton } from '../../components/ui';
import {
  AGGREGATE_LABELS,
  arcPath,
  type ChartData,
  compactNumber,
  formatValue,
  keyLabel,
  labelStep,
  niceTicks,
  OTHER_COLOR,
  pieSlices,
  seriesColor,
  valueExtent,
} from './chart-model';

/**
 * Dashboards: number and chart elements. Their data comes computed from the server (the
 * page's data route); these only draw it, in the Ledger style: thin marks, recessive axes and
 * grid, the categorical slots of index.css (green first), a legend for two or more series, a
 * hover tooltip per group or slice, and the numbers as a table for screen readers.
 */

export interface ElementData {
  data: InterfaceElementData | undefined;
  /** The element's table's fields, to name groups and format values. */
  fields: FieldMeta[] | undefined;
  loading: boolean;
}

const byId = (fields: FieldMeta[] | undefined, id: string | null | undefined) =>
  id ? fields?.find((f) => f.id === id) : undefined;

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-1 rounded-md border border-border bg-surface p-3">
      <h3 className="truncate text-small font-[550] text-text-2">{title}</h3>
      {children}
    </div>
  );
}

function Problem({ data }: { data: InterfaceElementData | undefined }) {
  return (
    <p className="text-small text-text-2">
      {data?.type === 'error' ? data.message : 'No data to show.'}
    </p>
  );
}

export function numberTitle(el: NumberElement, fields: FieldMeta[] | undefined): string {
  if (el.label) return el.label;
  const field = byId(fields, el.fieldId);
  if (el.fn === 'count' || !field) return 'Records';
  return `${AGGREGATE_LABELS[el.fn]} of ${field.name}`;
}

export function NumberView({ element, data }: { element: NumberElement; data: ElementData }) {
  const title = numberTitle(element, data.fields);
  const d = data.data;
  return (
    <Frame title={title}>
      {data.loading && !d ? (
        <Skeleton className="h-8 w-24" />
      ) : d?.type === 'number' ? (
        <>
          <p
            className="truncate text-[28px] leading-9 font-[600] tabular-nums text-text"
            data-testid="number-value"
          >
            {formatValue(d.value, element.fn, byId(data.fields, element.fieldId))}
          </p>
          {element.fn !== 'count' && (
            <p className="text-small text-text-3">
              {d.records === 1 ? '1 record' : `${d.records.toLocaleString('en')} records`}
            </p>
          )}
        </>
      ) : (
        <Problem data={d} />
      )}
    </Frame>
  );
}

export function chartTitle(el: ChartElement, fields: FieldMeta[] | undefined): string {
  if (el.label) return el.label;
  const group = byId(fields, el.groupFieldId)?.name ?? 'group';
  const value = byId(fields, el.fieldId);
  return el.fn === 'count' || !value
    ? `Records by ${group}`
    : `${AGGREGATE_LABELS[el.fn]} of ${value.name} by ${group}`;
}

/** The element's size in pixels, followed as it's resized. */
function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

interface Tip {
  x: number;
  y: number;
  title: string;
  lines: { color: string; label: string; value: string }[];
}

export function ChartView({ element, data }: { element: ChartElement; data: ElementData }) {
  const title = chartTitle(element, data.fields);
  const d = data.data;
  return (
    <Frame title={title}>
      {data.loading && !d ? (
        <Skeleton className="min-h-0 flex-1" />
      ) : d?.type === 'chart' ? (
        d.rows.length === 0 ? (
          <p className="text-small text-text-2">No records.</p>
        ) : (
          <ChartBody element={element} data={d} fields={data.fields} title={title} />
        )
      ) : (
        <Problem data={d} />
      )}
    </Frame>
  );
}

function ChartBody({
  element,
  data,
  fields,
  title,
}: {
  element: ChartElement;
  data: ChartData;
  fields: FieldMeta[] | undefined;
  title: string;
}) {
  const [ref, size] = useSize<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const groupField = byId(fields, element.groupFieldId);
  const seriesField = byId(fields, element.seriesFieldId);
  const valueField = byId(fields, element.fieldId);
  const pie = element.chart === 'pie' || element.chart === 'donut';
  const series = data.series;
  const seriesNames = series ? series.map((k) => keyLabel(seriesField, k)) : [title];
  const rowNames = data.rows.map((r) => keyLabel(groupField, r.key, r.other));
  const fmt = (v: number | null) => formatValue(v, element.fn, valueField);
  const legend = pie
    ? data.rows.map((r, i) => ({
        label: rowNames[i] ?? '',
        color: r.other ? OTHER_COLOR : seriesColor(i),
      }))
    : series && series.length > 1
      ? seriesNames.map((label, i) => ({ label, color: seriesColor(i) }))
      : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      <div ref={ref} className="relative min-h-0 flex-1" onPointerLeave={() => setTip(null)}>
        {size.width > 0 && size.height > 0 && (
          <svg
            width={size.width}
            height={size.height}
            role="img"
            aria-label={`${title}: chart`}
            className="block overflow-visible"
          >
            {pie ? (
              <Pie
                element={element}
                data={data}
                names={rowNames}
                fmt={fmt}
                width={size.width}
                height={size.height}
                onTip={setTip}
              />
            ) : (
              <Cartesian
                element={element}
                data={data}
                rowNames={rowNames}
                seriesNames={seriesNames}
                fmt={fmt}
                width={size.width}
                height={size.height}
                onTip={setTip}
              />
            )}
          </svg>
        )}
        {tip && (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-10 min-w-32 rounded-sm border border-border bg-surface px-2 py-1.5 text-small shadow-2"
            style={{
              left: Math.min(tip.x + 12, Math.max(0, size.width - 160)),
              top: Math.max(0, tip.y - 12),
            }}
          >
            <p className="mb-0.5 font-[550] text-text">{tip.title}</p>
            {tip.lines.map((l) => (
              <p key={l.label} className="flex items-center gap-1.5 text-text-2">
                <span className="size-2 shrink-0 rounded-full" style={{ background: l.color }} />
                <span className="truncate">{l.label}</span>
                <span className="ml-auto pl-2 tabular-nums text-text">{l.value}</span>
              </p>
            ))}
          </div>
        )}
      </div>
      {legend.length > 1 && (
        <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-small text-text-2" aria-hidden>
          {legend.map((l) => (
            <li key={l.label} className="flex min-w-0 items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-full" style={{ background: l.color }} />
              <span className="max-w-40 truncate">{l.label}</span>
            </li>
          ))}
        </ul>
      )}
      {data.truncated && (
        <p className="text-small text-text-3">
          {pie
            ? 'Showing the largest slices only.'
            : `Showing the first ${Math.min(data.rows.length, MAX_CHART_GROUPS)} groups${series ? ' and series' : ''}.`}
        </p>
      )}
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">{groupField?.name ?? 'Group'}</th>
            {seriesNames.map((n) => (
              <th key={n} scope="col">
                {n}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, i) => (
            <tr key={rowNames[i]}>
              <th scope="row">{rowNames[i]}</th>
              {r.values.map((v, j) => (
                <td key={seriesNames[j]}>{fmt(v)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const PAD = { top: 8, right: 8, bottom: 20, left: 44 };

/** A bar with its value end rounded (4 px) and its base end square, on the baseline. */
function barPath(x: number, y0: number, y1: number, w: number, round: boolean): string {
  const top = Math.min(y0, y1);
  const h = Math.abs(y1 - y0);
  const r = round ? Math.min(4, w / 2, h) : 0;
  const up = y1 <= y0;
  if (r === 0) return `M${x} ${top}h${w}v${h}h${-w}Z`;
  return up
    ? `M${x} ${top + h}V${top + r}q0 ${-r} ${r} ${-r}h${w - 2 * r}q${r} 0 ${r} ${r}V${top + h}Z`
    : `M${x} ${top}V${top + h - r}q0 ${r} ${r} ${r}h${w - 2 * r}q${r} 0 ${r} ${-r}V${top}Z`;
}

function Cartesian({
  element,
  data,
  rowNames,
  seriesNames,
  fmt,
  width,
  height,
  onTip,
}: {
  element: ChartElement;
  data: ChartData;
  rowNames: string[];
  seriesNames: string[];
  fmt: (v: number | null) => string;
  width: number;
  height: number;
  onTip: (tip: Tip | null) => void;
}) {
  const stacked = element.chart === 'stackedBar';
  const line = element.chart === 'line';
  const { min, max } = valueExtent(data, stacked);
  const ticks = niceTicks(min, max);
  const lo = ticks[0] ?? 0;
  const hi = ticks.at(-1) ?? 1;
  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const plotH = Math.max(1, height - PAD.top - PAD.bottom);
  const y = (v: number) => PAD.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const n = data.rows.length;
  const band = plotW / n;
  const cx = (i: number) => PAD.left + band * (i + 0.5);
  const step = labelStep(n, plotW);
  const width1 = data.series?.length ?? 1;
  const groupW = Math.min(band * 0.72, Math.max(8, 28 * (stacked ? 1 : width1)));
  const barW = stacked ? groupW : Math.max(2, groupW / width1 - (width1 > 1 ? 2 : 0));
  const zero = y(0);

  const tipFor = (i: number, at: number) => {
    const row = data.rows[i];
    if (!row) return;
    onTip({
      x: cx(i),
      y: at,
      title: rowNames[i] ?? '',
      lines: row.values.map((v, j) => ({
        color: seriesColor(j),
        label: seriesNames[j] ?? '',
        value: fmt(v),
      })),
    });
  };

  return (
    <g>
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={PAD.left}
            x2={width - PAD.right}
            y1={y(t)}
            y2={y(t)}
            stroke="var(--border)"
            strokeWidth={1}
            strokeDasharray={t === 0 ? undefined : '2 3'}
          />
          <text
            x={PAD.left - 6}
            y={y(t)}
            dy="0.32em"
            textAnchor="end"
            fontSize={11}
            fill="var(--text-3)"
          >
            {compactNumber(t)}
          </text>
        </g>
      ))}
      {data.rows.map((_row, i) =>
        i % step === 0 ? (
          <text
            key={`x${rowNames[i]}`}
            x={cx(i)}
            y={height - 4}
            textAnchor="middle"
            fontSize={11}
            fill="var(--text-3)"
          >
            {truncate(rowNames[i] ?? '', Math.max(4, Math.floor((band * step) / 7)))}
          </text>
        ) : null
      )}
      {line
        ? row0(data).map((_, j) => {
            const pts = data.rows.flatMap((r, i) => {
              const v = r.values[j];
              return v === null || v === undefined ? [] : [{ x: cx(i), y: y(v) }];
            });
            const color = seriesColor(j);
            return (
              <g key={seriesNames[j]}>
                <polyline
                  points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {pts.length <= 60 &&
                  pts.map((p) => (
                    <circle
                      key={`${p.x}`}
                      cx={p.x}
                      cy={p.y}
                      r={4}
                      fill={color}
                      stroke="var(--bg-surface)"
                      strokeWidth={2}
                    />
                  ))}
              </g>
            );
          })
        : data.rows.map((row, i) => {
            const left = cx(i) - groupW / 2;
            if (stacked) {
              let pos = 0;
              let neg = 0;
              const last = row.values.reduce<number>((acc, v, j) => ((v ?? 0) !== 0 ? j : acc), -1);
              return (
                <g key={rowNames[i]} data-testid="chart-bar">
                  {row.values.map((v, j) => {
                    const value = v ?? 0;
                    if (value === 0) return null;
                    const from = value > 0 ? pos : neg;
                    const to = from + value;
                    if (value > 0) pos = to;
                    else neg = to;
                    // A 2 px surface gap between stacked segments.
                    const gap = j < last ? 1 : 0;
                    const y0 = y(from) - (value > 0 ? (from === 0 ? 0 : 1) : 0);
                    const y1 = y(to) + (value > 0 ? gap : -gap);
                    return (
                      <path
                        key={seriesNames[j]}
                        d={barPath(left, y0, y1, groupW, j === last)}
                        fill={seriesColor(j)}
                      />
                    );
                  })}
                </g>
              );
            }
            return (
              <g key={rowNames[i]} data-testid="chart-bar">
                {row.values.map((v, j) =>
                  v === null ? null : (
                    <path
                      key={seriesNames[j]}
                      d={barPath(left + j * (barW + (width1 > 1 ? 2 : 0)), zero, y(v), barW, true)}
                      fill={seriesColor(j)}
                    />
                  )
                )}
              </g>
            );
          })}
      {data.rows.map((_row, i) => (
        // Hover targets: the whole band of each group, wider than its marks.
        <rect
          key={`hit${rowNames[i]}`}
          x={PAD.left + band * i}
          y={PAD.top}
          width={band}
          height={plotH}
          fill="transparent"
          onPointerMove={(e) => {
            const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
            tipFor(i, e.clientY - box.top);
          }}
        />
      ))}
    </g>
  );
}

const row0 = (data: ChartData) => data.rows[0]?.values ?? [];

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function Pie({
  element,
  data,
  names,
  fmt,
  width,
  height,
  onTip,
}: {
  element: ChartElement;
  data: ChartData;
  names: string[];
  fmt: (v: number | null) => string;
  width: number;
  height: number;
  onTip: (tip: Tip | null) => void;
}) {
  const r = Math.max(8, Math.min(width, height) / 2 - 4);
  const inner = element.chart === 'donut' ? r * 0.6 : 0;
  const cx = width / 2;
  const cy = height / 2;
  const values = data.rows.map((row) => row.values[0] ?? null);
  const slices = pieSlices(values);
  const total = values.reduce<number>((a, v) => a + Math.max(0, v ?? 0), 0);
  return (
    <g>
      {slices.map((s, i) => {
        const row = data.rows[i];
        if (!row || s.end <= s.start) return null;
        const color = row.other ? OTHER_COLOR : seriesColor(i);
        const share = total > 0 ? Math.round(((row.values[0] ?? 0) / total) * 100) : 0;
        return (
          <path
            key={names[i]}
            data-testid="chart-slice"
            d={arcPath(cx, cy, r, inner, s.start, s.end)}
            fill={color}
            stroke="var(--bg-surface)"
            strokeWidth={2}
            onPointerMove={(e) => {
              const box = (
                e.currentTarget.ownerSVGElement as SVGSVGElement
              ).getBoundingClientRect();
              onTip({
                x: e.clientX - box.left,
                y: e.clientY - box.top,
                title: names[i] ?? '',
                lines: [{ color, label: `${share}%`, value: fmt(row.values[0] ?? null) }],
              });
            }}
          />
        );
      })}
      {inner > 0 && element.fn !== 'avg' && element.fn !== 'min' && element.fn !== 'max' && (
        <text
          x={cx}
          y={cy}
          dy="0.35em"
          textAnchor="middle"
          fontSize={Math.max(12, Math.min(22, inner / 2.4))}
          fontWeight={600}
          fill="var(--text)"
        >
          {fmt(total)}
        </text>
      )}
    </g>
  );
}

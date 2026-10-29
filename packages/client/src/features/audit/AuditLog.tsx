import type { AuditList, AuditStreamSaved } from '@openrows/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { ApiError, auditApi } from '../../api/client';
import { queryKeys } from '../../api/keys';
import { useAuditLog, useAuditStream } from '../../api/queries';
import { Button, buttonVariants, Input, Skeleton, toast } from '../../components/ui';
import {
  ACTION_LABELS,
  type AuditFilterForm,
  actorText,
  CATEGORY_OPTIONS,
  EMPTY_FILTERS,
  exportUrl,
  filterQuery,
  summaryLines,
  targetText,
  timeText,
  unavailable,
} from './model';

const section = 'rounded-lg border border-border bg-surface p-5 shadow-1';
const selectClass =
  'h-8 rounded-sm border border-border bg-surface px-2 text-body text-text hover:border-border-strong';

/**
 * The workspace audit log, for its owners on the Enterprise plan: who did what, when and
 * from where, newest first, with filters by kind, text and dates; CSV and JSON lines exports of
 * what the filters show; and the SIEM stream. Self-hosted servers have no audit log (404) and
 * other plans are told what they need (403 PLAN_FEATURE_REQUIRED).
 */
export function AuditLogPanels({ workspaceId }: { workspaceId: string }) {
  const [form, setForm] = useState<AuditFilterForm>(EMPTY_FILTERS);
  const filters = useMemo(() => filterQuery(form), [form]);
  const log = useAuditLog(workspaceId, filters);
  const first = log.data?.pages[0];
  const blocked = log.isError && !first ? unavailable(log.error) : null;

  if (blocked === 'edition') {
    return (
      <section className={section}>
        <h2 className="mb-1 text-heading font-semibold">Audit log</h2>
        <p className="text-text-2">This OpenRows server doesn't keep an audit log.</p>
      </section>
    );
  }
  if (blocked === 'plan') {
    return (
      <section className={section}>
        <h2 className="mb-1 text-heading font-semibold">Audit log</h2>
        <p className="text-text-2">
          The audit log is part of the Enterprise plan. It records sign-ins, member and role
          changes, share links, access tokens, exports, deletions, settings and automation edits.
        </p>
      </section>
    );
  }
  return (
    <>
      <AuditFilters form={form} onChange={setForm} workspaceId={workspaceId} filters={filters} />
      <AuditTable log={log} retention={first?.retentionDays} blocked={blocked !== null} />
      {first && <AuditStreamPanel workspaceId={workspaceId} />}
    </>
  );
}

function AuditFilters({
  form,
  onChange,
  workspaceId,
  filters,
}: {
  form: AuditFilterForm;
  onChange: (next: AuditFilterForm) => void;
  workspaceId: string;
  filters: Record<string, string>;
}) {
  const id = useId();
  const set = (patch: Partial<AuditFilterForm>) => onChange({ ...form, ...patch });
  return (
    <section aria-label="Filters" className="flex flex-wrap items-end gap-3">
      <div className="grid gap-1">
        <label htmlFor={`${id}-category`} className="text-small text-text-2">
          Activity
        </label>
        <select
          id={`${id}-category`}
          className={selectClass}
          value={form.category}
          onChange={(e) => set({ category: e.target.value })}
        >
          <option value="">Everything</option>
          {CATEGORY_OPTIONS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1">
        <label htmlFor={`${id}-q`} className="text-small text-text-2">
          Person or item
        </label>
        <Input
          id={`${id}-q`}
          type="search"
          className="w-56"
          placeholder="Email, name or id"
          value={form.q}
          maxLength={200}
          onChange={(e) => set({ q: e.target.value })}
        />
      </div>
      <div className="grid gap-1">
        <label htmlFor={`${id}-from`} className="text-small text-text-2">
          From
        </label>
        <Input
          id={`${id}-from`}
          type="date"
          value={form.from}
          onChange={(e) => set({ from: e.target.value })}
        />
      </div>
      <div className="grid gap-1">
        <label htmlFor={`${id}-to`} className="text-small text-text-2">
          To
        </label>
        <Input
          id={`${id}-to`}
          type="date"
          value={form.to}
          onChange={(e) => set({ to: e.target.value })}
        />
      </div>
      <div className="ml-auto flex gap-2">
        <a
          className={buttonVariants({ variant: 'secondary' })}
          href={exportUrl(workspaceId, filters, 'csv')}
          download
        >
          Export CSV
        </a>
        <a
          className={buttonVariants({ variant: 'secondary' })}
          href={exportUrl(workspaceId, filters, 'json')}
          download
        >
          Export JSON
        </a>
      </div>
    </section>
  );
}

function AuditTable({
  log,
  retention,
  blocked,
}: {
  log: ReturnType<typeof useAuditLog>;
  retention: number | null | undefined;
  blocked: boolean;
}) {
  const events = log.data?.pages.flatMap((p: AuditList) => p.events) ?? [];
  if (blocked) {
    return (
      <p role="alert" className="text-text-2">
        Couldn't load the audit log.
      </p>
    );
  }
  if (!log.data) return <Skeleton className="h-60" />;
  return (
    <section aria-label="Audit log entries" className="grid gap-3">
      <div className="overflow-x-auto rounded-lg border border-border bg-surface shadow-1">
        <table className="w-full text-left text-body">
          <caption className="sr-only">Audit log, newest first</caption>
          <thead className="border-b border-border text-small text-text-2">
            <tr>
              <th scope="col" className="h-[34px] px-3 font-medium">
                Time
              </th>
              <th scope="col" className="px-3 font-medium">
                Who
              </th>
              <th scope="col" className="px-3 font-medium">
                What
              </th>
              <th scope="col" className="px-3 font-medium">
                Details
              </th>
              <th scope="col" className="px-3 font-medium">
                IP address
              </th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} className="border-b border-border align-top last:border-b-0">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums text-text-2">
                  <time dateTime={e.at}>{timeText(e.at)}</time>
                </td>
                <td className="px-3 py-2">{actorText(e)}</td>
                <td className="px-3 py-2">
                  <div>{ACTION_LABELS[e.action]}</div>
                  <div className="text-small text-text-2">{targetText(e)}</div>
                </td>
                <td className="px-3 py-2 text-small text-text-2">
                  {summaryLines(e).map((line) => (
                    <div key={line} className="max-w-xs truncate" title={line}>
                      {line}
                    </div>
                  ))}
                </td>
                <td
                  className="whitespace-nowrap px-3 py-2 text-small text-text-2"
                  title={e.userAgent ?? undefined}
                >
                  {e.ip ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {events.length === 0 && (
          <p className="px-3 py-6 text-center text-text-2">Nothing matches these filters yet.</p>
        )}
      </div>
      <div className="flex items-center gap-3">
        {log.hasNextPage && (
          <Button
            variant="secondary"
            onClick={() => void log.fetchNextPage()}
            disabled={log.isFetchingNextPage}
          >
            Load older entries
          </Button>
        )}
        <p className="text-small text-text-2">
          {retention === null || retention === undefined
            ? 'Entries are kept indefinitely.'
            : `Entries are kept for ${retention} days.`}
        </p>
      </div>
    </section>
  );
}

function AuditStreamPanel({ workspaceId }: { workspaceId: string }) {
  const id = useId();
  const qc = useQueryClient();
  const stream = useAuditStream(workspaceId, true);
  const current = stream.data?.stream ?? null;
  const [url, setUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const value = url ?? current?.url ?? '';

  const saved = (next: AuditStreamSaved) => {
    qc.setQueryData(queryKeys.workspaces.auditStream(workspaceId), { stream: next.stream });
    setUrl(null);
    setSecret(next.secret);
    toast.success('Audit log stream saved');
  };
  const failed = (fallback: string) => (err: unknown) =>
    toast.error(err instanceof ApiError ? err.message : fallback);
  const save = useMutation({
    mutationFn: (input: { enabled?: boolean; rotateSecret?: boolean }) =>
      auditApi.stream.put({
        params: { workspaceId },
        body: { url: value, enabled: input.enabled ?? current?.enabled ?? true, ...input },
      }),
    onSuccess: saved,
    onError: failed("Couldn't save the stream"),
  });
  const remove = useMutation({
    mutationFn: () => auditApi.stream.delete({ params: { workspaceId } }),
    onSuccess: () => {
      qc.setQueryData(queryKeys.workspaces.auditStream(workspaceId), { stream: null });
      setSecret(null);
      setUrl(null);
      toast.success('Audit log stream removed');
    },
    onError: failed("Couldn't remove the stream"),
  });

  return (
    <section aria-labelledby={`${id}-title`} className={section}>
      <h2 id={`${id}-title`} className="mb-1 text-heading font-semibold">
        Stream to your SIEM
      </h2>
      <p className="mb-4 text-text-2">
        New entries are sent every minute as signed JSON to your endpoint, the way webhooks are
        signed (<code>X-OpenRows-Signature</code>).
      </p>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({});
        }}
      >
        <div className="grid min-w-64 flex-1 gap-1">
          <label htmlFor={`${id}-url`} className="text-small text-text-2">
            Endpoint URL
          </label>
          <Input
            id={`${id}-url`}
            type="url"
            required
            maxLength={2048}
            placeholder="https://siem.example.com/ingest"
            value={value}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={save.isPending || !value}>
          {current ? 'Save' : 'Start streaming'}
        </Button>
      </form>
      {secret && (
        <div className="mt-4 rounded-md border border-border bg-app p-3" role="status">
          <p className="mb-1 text-small text-text-2">
            Signing secret: copy it now, it won't be shown again.
          </p>
          <code className="break-all" data-testid="audit-stream-secret">
            {secret}
          </code>
        </div>
      )}
      {current && (
        <div className="mt-4 grid gap-3">
          <p className="text-text-2" data-testid="audit-stream-state">
            {!current.enabled
              ? `Off${current.lastError ? ` after failed deliveries (${current.lastError})` : ''}.`
              : current.lastError
                ? `On. The last delivery failed (${current.lastError}); it is retried every minute.`
                : current.lastDeliveryAt
                  ? `On. Last delivery ${timeText(current.lastDeliveryAt)}.`
                  : 'On. Nothing sent yet.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={save.isPending}
              onClick={() => save.mutate({ enabled: !current.enabled })}
            >
              {current.enabled ? 'Turn off' : 'Turn on'}
            </Button>
            <Button
              variant="secondary"
              disabled={save.isPending}
              onClick={() => save.mutate({ rotateSecret: true })}
            >
              New signing secret
            </Button>
            <Button variant="secondary" disabled={remove.isPending} onClick={() => remove.mutate()}>
              Remove
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

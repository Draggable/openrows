import {
  type Base,
  MAX_WEBHOOKS_PER_BASE,
  WEBHOOK_SIGNATURE_HEADER,
  type Webhook,
  type WebhookDelivery,
  type WebhookEventType,
} from '@openrows/shared';
import {
  ArrowLeftIcon,
  CheckIcon,
  CopyIcon,
  KeyRoundIcon,
  PlusIcon,
  RotateCcwIcon,
  SendIcon,
  Trash2Icon,
  WebhookIcon,
  XIcon,
} from 'lucide-react';
import { useId, useState } from 'react';
import { ApiError } from '../../api/client';
import {
  useCreateWebhook,
  useDeleteWebhook,
  usePingWebhook,
  useRedeliverWebhook,
  useUpdateWebhook,
  useWebhookDeliveries,
  useWebhooks,
} from '../../api/queries';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Skeleton,
  toast,
} from '../../components/ui';
import { API_DOCS_PATH } from '../api-docs/ApiDocsPage';
import {
  canManageWebhooks,
  canRedeliver,
  deliveryResult,
  EVENT_GROUPS,
  eventLabel,
  eventsSummary,
  isWebhookUrl,
  webhookStatus,
} from './model';

const message = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback;

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

const checkboxClass = 'size-4 shrink-0 accent-[var(--accent)]';

type Mode = { kind: 'list' } | { kind: 'create' } | { kind: 'log'; webhook: Webhook };

/**
 * A base's webhooks (creators and owners, from the base menu): the list with each one's
 * status, a form for a new one, the signing secret shown once (at creation and rotation), a
 * test ping, turning one off and on, and its delivery log of the last 7 days.
 */
export function WebhooksDialog({
  base,
  tables,
  open,
  onOpenChange,
}: {
  base: Base;
  tables: readonly { id: string; name: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [secret, setSecret] = useState<string | null>(null);
  const close = (next: boolean) => {
    if (!next) {
      setMode({ kind: 'list' });
      setSecret(null);
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-[680px]">
        <DialogHeader>
          <DialogTitle>Webhooks</DialogTitle>
          <DialogDescription>
            Send signed JSON to a URL when records, fields or tables of {base.name} change. Failed
            deliveries are retried for about a day.{' '}
            <a className="underline" href={`${API_DOCS_PATH}#webhooks`}>
              Verifying signatures
            </a>
          </DialogDescription>
        </DialogHeader>
        {secret && <SecretPanel secret={secret} onDone={() => setSecret(null)} />}
        {mode.kind === 'create' ? (
          <CreateWebhookForm
            base={base}
            tables={tables}
            onCancel={() => setMode({ kind: 'list' })}
            onCreated={(s) => {
              setSecret(s);
              setMode({ kind: 'list' });
            }}
          />
        ) : mode.kind === 'log' ? (
          <DeliveryLog
            base={base}
            webhook={mode.webhook}
            onBack={() => setMode({ kind: 'list' })}
          />
        ) : (
          <WebhookList
            base={base}
            onCreate={() => setMode({ kind: 'create' })}
            onLog={(webhook) => setMode({ kind: 'log', webhook })}
            onSecret={setSecret}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SecretPanel({ secret, onDone }: { secret: string; onDone: () => void }) {
  const fieldId = useId();
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      toast.success('Signing secret copied');
    } catch {
      toast.error("Couldn't copy. Select the secret and copy it.");
    }
  };
  return (
    <section
      aria-label="Signing secret"
      className="flex shrink-0 flex-col gap-2 rounded-sm border border-border bg-surface p-3"
    >
      <label htmlFor={fieldId} className="font-[550]">
        Signing secret
      </label>
      <p className="text-small text-text-2">
        Copy it now: it isn't shown again. Your receiver uses it to check the
        <code className="mx-1 font-mono">{WEBHOOK_SIGNATURE_HEADER}</code>header.
      </p>
      <div className="flex items-center gap-2">
        <Input
          id={fieldId}
          readOnly
          value={secret}
          className="font-mono text-small"
          onFocus={(e) => e.target.select()}
        />
        <Button variant="secondary" onClick={onCopy}>
          <CopyIcon />
          Copy
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
    </section>
  );
}

function WebhookList({
  base,
  onCreate,
  onLog,
  onSecret,
}: {
  base: Base;
  onCreate: () => void;
  onLog: (w: Webhook) => void;
  onSecret: (secret: string) => void;
}) {
  const list = useWebhooks(base.id);
  const update = useUpdateWebhook(base.id);
  const remove = useDeleteWebhook(base.id);
  const ping = usePingWebhook(base.id);
  const manage = canManageWebhooks(base.role);
  const count = list.data?.webhooks.length ?? 0;
  const busy = update.isPending || remove.isPending || ping.isPending;

  const onToggle = (w: Webhook) =>
    update.mutate(
      { webhookId: w.id, enabled: !w.enabled },
      {
        onSuccess: (u) => toast.success(u.enabled ? 'Webhook turned on' : 'Webhook turned off'),
        onError: (err) => toast.error(message(err, "Couldn't change the webhook")),
      }
    );
  const onRotate = (w: Webhook) => {
    if (
      !window.confirm(
        'Make a new signing secret? The current one keeps signing deliveries for 24 hours, so you can switch your receiver over.'
      )
    ) {
      return;
    }
    update.mutate(
      { webhookId: w.id, rotateSecret: true },
      {
        onSuccess: (u) => {
          if (u.secret) onSecret(u.secret);
        },
        onError: (err) => toast.error(message(err, "Couldn't rotate the secret")),
      }
    );
  };
  const onExpirePrevious = (w: Webhook) => {
    if (!window.confirm('Stop signing with the previous secret now?')) return;
    update.mutate(
      { webhookId: w.id, expirePreviousSecret: true },
      {
        onSuccess: () => toast.success('Only the current secret signs now'),
        onError: (err) => toast.error(message(err, "Couldn't change the webhook")),
      }
    );
  };
  const onDelete = (w: Webhook) => {
    if (!window.confirm(`Delete the webhook to ${w.url} and its delivery log?`)) return;
    remove.mutate(w.id, {
      onSuccess: () => toast.success('Webhook deleted'),
      onError: (err) => toast.error(message(err, "Couldn't delete the webhook")),
    });
  };
  const onPing = (w: Webhook) =>
    ping.mutate(w.id, {
      onSuccess: (d) =>
        d.success
          ? toast.success(`Test ping delivered (${deliveryResult(d)})`)
          : toast.error(`Test ping failed: ${deliveryResult(d)}`),
      onError: (err) => toast.error(message(err, "Couldn't send the test ping")),
    });

  return (
    <>
      {manage && (
        <div className="flex shrink-0 items-center justify-between gap-2">
          <Button onClick={onCreate} disabled={count >= MAX_WEBHOOKS_PER_BASE}>
            <PlusIcon />
            New webhook
          </Button>
          <span className="text-small text-text-2">
            {count} of {MAX_WEBHOOKS_PER_BASE}
          </span>
        </div>
      )}
      <div className="min-h-[160px] flex-1 overflow-y-auto">
        {list.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : list.isError ? (
          <p className="py-6 text-center text-text-2">
            {message(list.error, "Couldn't load the webhooks.")}
          </p>
        ) : !list.data.webhooks.length ? (
          <p className="py-6 text-center text-text-2">
            No webhooks yet. Add one to send changes to n8n, Zapier, Make or your own code.
          </p>
        ) : (
          <ul aria-label="Webhooks" className="flex flex-col divide-y divide-border">
            {list.data.webhooks.map((w) => {
              const status = webhookStatus(w);
              return (
                <li key={w.id} className="flex flex-col gap-1.5 py-2.5">
                  <div className="flex items-center gap-2">
                    <WebhookIcon className="size-4 shrink-0 text-text-2" aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-mono text-small" title={w.url}>
                      {w.url}
                    </span>
                    <span
                      className={
                        status.tone === 'warn'
                          ? 'shrink-0 text-small text-danger'
                          : 'shrink-0 text-small text-text-2'
                      }
                    >
                      {status.label}
                    </span>
                  </div>
                  <div className="truncate pl-6 text-small text-text-2">
                    {w.description ? `${w.description} · ` : ''}
                    {eventsSummary(w.events)}
                  </div>
                  {w.previousSecretExpiresAt && (
                    <div className="flex flex-wrap items-center gap-1 pl-6 text-small text-text-2">
                      <span>
                        The previous secret also signs until{' '}
                        {new Date(w.previousSecretExpiresAt).toLocaleString(undefined, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                        .
                      </span>
                      {manage && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => onExpirePrevious(w)}
                          aria-label={`Stop using the previous secret of ${w.url}`}
                        >
                          Stop using it now
                        </Button>
                      )}
                    </div>
                  )}
                  {manage && (
                    <div className="flex flex-wrap items-center gap-1 pl-5">
                      <Button size="sm" variant="ghost" onClick={() => onLog(w)}>
                        Delivery log
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => onPing(w)}>
                        <SendIcon />
                        Test
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => onToggle(w)}>
                        {w.enabled ? 'Turn off' : 'Turn on'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => onRotate(w)}
                        aria-label={`Rotate the signing secret of ${w.url}`}
                      >
                        <KeyRoundIcon />
                        Rotate secret
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => onDelete(w)}
                        aria-label={`Delete the webhook to ${w.url}`}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

function CreateWebhookForm({
  base,
  tables,
  onCancel,
  onCreated,
}: {
  base: Base;
  tables: readonly { id: string; name: string }[];
  onCancel: () => void;
  onCreated: (secret: string) => void;
}) {
  const create = useCreateWebhook(base.id);
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<WebhookEventType[]>([
    'record.created',
    'record.updated',
    'record.deleted',
  ]);
  const [tableIds, setTableIds] = useState<string[] | null>(null);
  const urlId = useId();
  const descriptionId = useId();
  const valid = isWebhookUrl(url) && events.length > 0 && (tableIds === null || tableIds.length);

  const toggle = <T,>(list: T[], value: T, on: boolean) =>
    on ? [...list, value] : list.filter((v) => v !== value);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    create.mutate(
      { url: url.trim(), description, events, tableIds },
      {
        onSuccess: (w) => {
          toast.success('Webhook created');
          if (w.secret) onCreated(w.secret);
        },
        onError: (err) => toast.error(message(err, "Couldn't create the webhook")),
      }
    );
  };

  return (
    <form
      aria-label="New webhook"
      onSubmit={onSubmit}
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={urlId} className="font-[550]">
          URL
        </label>
        <Input
          id={urlId}
          type="url"
          required
          autoFocus
          placeholder="https://example.com/hooks/openrows"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <span className="text-small text-text-2">
          https on port 443, on a public address. Every delivery is a POST.
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={descriptionId} className="font-[550]">
          Description <span className="font-normal text-text-2">(optional)</span>
        </label>
        <Input
          id={descriptionId}
          maxLength={200}
          placeholder="e.g. Sync to the CRM"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-1 font-[550]">Events</legend>
        {EVENT_GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col gap-1">
            <span className="text-small text-text-2">{group.label}</span>
            {group.events.map((ev) => (
              <label key={ev.type} className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  className={checkboxClass}
                  aria-label={`${group.label}: ${ev.label}`}
                  checked={events.includes(ev.type)}
                  onChange={(e) => setEvents(toggle(events, ev.type, e.target.checked))}
                />
                {ev.label}
              </label>
            ))}
          </div>
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 font-[550]">Tables</legend>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className={checkboxClass}
            checked={tableIds === null}
            onChange={(e) => setTableIds(e.target.checked ? null : [])}
          />
          Every table, including new ones
        </label>
        {tableIds !== null &&
          tables.map((t) => (
            <label key={t.id} className="flex cursor-pointer items-center gap-2 pl-6">
              <input
                type="checkbox"
                className={checkboxClass}
                checked={tableIds.includes(t.id)}
                onChange={(e) => setTableIds(toggle(tableIds, t.id, e.target.checked))}
              />
              {t.name}
            </label>
          ))}
      </fieldset>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid || create.isPending}>
          {create.isPending ? 'Creating…' : 'Create webhook'}
        </Button>
      </div>
    </form>
  );
}

function DeliveryLog({
  base,
  webhook,
  onBack,
}: {
  base: Base;
  webhook: Webhook;
  onBack: () => void;
}) {
  const log = useWebhookDeliveries(base.id, webhook.id);
  const redeliver = useRedeliverWebhook(base.id, webhook.id);
  const resend = (d: WebhookDelivery) =>
    redeliver.mutate(d.id, {
      onSuccess: () => toast.success('Redelivery queued. The attempt shows here in a moment.'),
      onError: (err) => toast.error(message(err, "Couldn't redeliver the event")),
    });
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeftIcon />
          Webhooks
        </Button>
        <span className="min-w-0 truncate font-mono text-small text-text-2" title={webhook.url}>
          {webhook.url}
        </span>
      </div>
      <div className="min-h-[160px] flex-1 overflow-y-auto">
        {log.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : log.isError ? (
          <p className="py-6 text-center text-text-2">
            {message(log.error, "Couldn't load the delivery log.")}
          </p>
        ) : !log.data.deliveries.length ? (
          <p className="py-6 text-center text-text-2">
            No deliveries in the last 7 days. Send a test, or change a record.
          </p>
        ) : (
          <ul aria-label="Deliveries" className="flex flex-col divide-y divide-border">
            {log.data.deliveries.map((d) => (
              <li key={d.id} className="py-1.5">
                <details>
                  <summary className="flex cursor-pointer list-none items-center gap-2">
                    {d.success ? (
                      <CheckIcon className="size-4 shrink-0 text-text-2" aria-label="Delivered" />
                    ) : (
                      <XIcon className="size-4 shrink-0 text-danger" aria-label="Failed" />
                    )}
                    <span className="w-44 shrink-0 text-small text-text-2">
                      {when(d.createdAt)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {eventLabel(d.eventType)}
                      {d.attempt > 1 ? ` · attempt ${d.attempt}` : ''}
                    </span>
                    <span className={d.success ? 'text-small' : 'text-small text-danger'}>
                      {deliveryResult(d)}
                    </span>
                  </summary>
                  <dl className="mt-1 ml-6 grid grid-cols-[auto_1fr] gap-x-3 text-small">
                    <dt className="text-text-2">Event id</dt>
                    <dd className="font-mono">{d.eventId}</dd>
                    {d.error && (
                      <>
                        <dt className="text-text-2">Error</dt>
                        <dd>{d.error}</dd>
                      </>
                    )}
                    {d.responseBody !== null && (
                      <>
                        <dt className="text-text-2">Response</dt>
                        <dd>
                          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono">
                            {d.responseBody || '(empty)'}
                          </pre>
                        </dd>
                      </>
                    )}
                  </dl>
                  {canRedeliver(d) && (
                    <div className="mt-1 ml-6">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!webhook.enabled || redeliver.isPending}
                        title={webhook.enabled ? undefined : 'Turn the webhook on to redeliver'}
                        onClick={() => resend(d)}
                      >
                        <RotateCcwIcon />
                        Redeliver
                      </Button>
                    </div>
                  )}
                </details>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

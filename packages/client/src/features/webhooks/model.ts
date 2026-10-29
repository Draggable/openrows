import type { UserRole, Webhook, WebhookDelivery, WebhookEventType } from '@openrows/shared';

/** Webhooks are managed by the base's creators and owners. */
export const canManageWebhooks = (role: UserRole | null | undefined) =>
  role === 'owner' || role === 'creator';

/** The event types as the form groups them. */
export const EVENT_GROUPS: {
  label: string;
  events: { type: WebhookEventType; label: string }[];
}[] = [
  {
    label: 'Records',
    events: [
      { type: 'record.created', label: 'Created' },
      { type: 'record.updated', label: 'Updated' },
      { type: 'record.deleted', label: 'Deleted' },
      { type: 'record.restored', label: 'Restored' },
      { type: 'form.submitted', label: 'Form submitted' },
    ],
  },
  {
    label: 'Fields',
    events: [
      { type: 'field.created', label: 'Created' },
      { type: 'field.updated', label: 'Changed' },
      { type: 'field.deleted', label: 'Deleted' },
      { type: 'field.restored', label: 'Restored' },
    ],
  },
  {
    label: 'Tables',
    events: [
      { type: 'table.created', label: 'Created' },
      { type: 'table.updated', label: 'Changed' },
      { type: 'table.deleted', label: 'Deleted' },
      { type: 'table.restored', label: 'Restored' },
    ],
  },
  {
    label: 'Comments',
    events: [
      { type: 'comment.created', label: 'Added' },
      { type: 'comment.updated', label: 'Edited' },
      { type: 'comment.deleted', label: 'Deleted' },
    ],
  },
];

const EVENT_LABELS = new Map(
  EVENT_GROUPS.flatMap((g) => g.events.map((e) => [e.type, `${g.label}: ${e.label}`] as const))
);

/** "Records: Created, Updated" style, for a webhook row. */
export function eventsSummary(events: readonly WebhookEventType[]): string {
  const parts: string[] = [];
  for (const group of EVENT_GROUPS) {
    const picked = group.events.filter((e) => events.includes(e.type)).map((e) => e.label);
    if (picked.length) parts.push(`${group.label}: ${picked.join(', ')}`);
  }
  return parts.join(' · ');
}

export const eventLabel = (type: string) =>
  type === 'ping' ? 'Test ping' : (EVENT_LABELS.get(type as WebhookEventType) ?? type);

/** What a webhook's status line says. */
export function webhookStatus(w: Webhook): { label: string; tone: 'ok' | 'warn' | 'off' } {
  if (!w.enabled) {
    if (w.disabledReason === 'failures') return { label: 'Off: too many failures', tone: 'warn' };
    if (w.disabledReason === 'creator_access') {
      return { label: 'Off: its creator lost access', tone: 'warn' };
    }
    return { label: 'Off', tone: 'off' };
  }
  if (w.consecutiveFailures > 0) {
    return {
      label: `Failing (${w.consecutiveFailures} in a row)`,
      tone: 'warn',
    };
  }
  return { label: w.lastDeliveryAt ? 'On · delivering' : 'On', tone: 'ok' };
}

/** "200 · 41 ms" or the error, for a delivery row. */
export function deliveryResult(d: WebhookDelivery): string {
  const status = d.responseStatus !== null ? `HTTP ${d.responseStatus}` : (d.error ?? 'No answer');
  return `${status} · ${d.durationMs} ms`;
}

/** A failed delivery of a real event (not a test ping) can be sent again. */
export const canRedeliver = (d: WebhookDelivery) => !d.success && d.eventType !== 'ping';

/** An http(s) URL the form accepts (the server checks the rest). */
export function isWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

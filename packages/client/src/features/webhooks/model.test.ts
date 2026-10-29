import type { Webhook, WebhookDelivery } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import {
  canManageWebhooks,
  deliveryResult,
  eventLabel,
  eventsSummary,
  isWebhookUrl,
  webhookStatus,
} from './model';

const hook = (over: Partial<Webhook> = {}): Webhook => ({
  id: '01900000-0000-7000-8000-000000000001',
  baseId: '01900000-0000-7000-8000-000000000002',
  url: 'https://example.com/in',
  description: '',
  events: ['record.created'],
  tableIds: null,
  fieldIds: null,
  enabled: true,
  disabledReason: null,
  consecutiveFailures: 0,
  lastDeliveryAt: null,
  lastSuccess: null,
  previousSecretExpiresAt: null,
  createdBy: null,
  createdAt: '2026-10-26T10:00:00.000Z',
  updatedAt: '2026-10-26T10:00:00.000Z',
  ...over,
});

describe('webhooks model (#107)', () => {
  it('lets creators and owners manage webhooks', () => {
    expect(canManageWebhooks('owner')).toBe(true);
    expect(canManageWebhooks('creator')).toBe(true);
    expect(canManageWebhooks('editor')).toBe(false);
    expect(canManageWebhooks(null)).toBe(false);
  });

  it('summarises events by group', () => {
    expect(eventsSummary(['record.updated', 'record.created', 'table.deleted'])).toBe(
      'Records: Created, Updated · Tables: Deleted'
    );
    expect(eventLabel('form.submitted')).toBe('Records: Form submitted');
    expect(eventLabel('ping')).toBe('Test ping');
  });

  it('says why a webhook is off or failing', () => {
    expect(webhookStatus(hook()).label).toBe('On');
    expect(webhookStatus(hook({ consecutiveFailures: 3 }))).toEqual({
      label: 'Failing (3 in a row)',
      tone: 'warn',
    });
    expect(webhookStatus(hook({ enabled: false })).tone).toBe('off');
    expect(webhookStatus(hook({ enabled: false, disabledReason: 'failures' })).label).toBe(
      'Off: too many failures'
    );
    expect(webhookStatus(hook({ enabled: false, disabledReason: 'creator_access' })).label).toBe(
      'Off: its creator lost access'
    );
  });

  it('describes a delivery attempt and checks URLs', () => {
    const d = { responseStatus: 200, error: null, durationMs: 41 } as WebhookDelivery;
    expect(deliveryResult(d)).toBe('HTTP 200 · 41 ms');
    expect(
      deliveryResult({
        ...d,
        responseStatus: null,
        error: 'The request timed out',
        durationMs: 10000,
      })
    ).toBe('The request timed out · 10000 ms');
    expect(isWebhookUrl('https://example.com/x')).toBe(true);
    expect(isWebhookUrl('ftp://example.com')).toBe(false);
    expect(isWebhookUrl('nope')).toBe(false);
  });
});

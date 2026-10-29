import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateWebhookSecret,
  signatureHeader,
  verifyWebhookSignature,
  webhookSignature,
} from './signature.js';

describe('webhook signatures (#107)', () => {
  const secret = 'whsec_test';
  const body = '{"id":"e1","type":"record.updated"}';

  it('signs `t.body` with HMAC-SHA256 in the documented header format', () => {
    const header = signatureHeader(secret, 1_700_000_000, body);
    const expected = createHmac('sha256', secret).update(`1700000000.${body}`).digest('hex');
    expect(header).toBe(`t=1700000000,v1=${expected}`);
    expect(webhookSignature(secret, 1_700_000_000, body)).toBe(expected);
  });

  it('carries one v1 per secret during a rotation grace period (#124)', () => {
    const now = 1_700_000_000;
    const header = signatureHeader([secret, 'whsec_old'], now, body);
    expect(header.split(',')).toHaveLength(3);
    expect(header.startsWith(`t=${now},v1=${webhookSignature(secret, now, body)},v1=`)).toBe(true);
    expect(verifyWebhookSignature(secret, header, body, { now })).toBe(true);
    expect(verifyWebhookSignature('whsec_old', header, body, { now })).toBe(true);
    expect(verifyWebhookSignature('whsec_other', header, body, { now })).toBe(false);
  });

  it('verifies within the tolerance and refuses replays, tampering and other secrets', () => {
    const now = 1_700_000_000;
    const header = signatureHeader(secret, now, body);
    expect(verifyWebhookSignature(secret, header, body, { now })).toBe(true);
    expect(verifyWebhookSignature(secret, header, body, { now: now + 299 })).toBe(true);
    // Replayed more than 5 minutes later.
    expect(verifyWebhookSignature(secret, header, body, { now: now + 301 })).toBe(false);
    expect(verifyWebhookSignature(secret, header, `${body} `, { now })).toBe(false);
    expect(verifyWebhookSignature('whsec_other', header, body, { now })).toBe(false);
    expect(verifyWebhookSignature(secret, 'v1=abc', body, { now })).toBe(false);
    expect(verifyWebhookSignature(secret, '', body, { now })).toBe(false);
  });

  it('accepts any of several v1 signatures (a receiver mid-rotation)', () => {
    const now = 1_700_000_000;
    const good = webhookSignature(secret, now, body);
    expect(verifyWebhookSignature(secret, `t=${now},v1=deadbeef,v1=${good}`, body, { now })).toBe(
      true
    );
  });

  it('makes random 256-bit secrets', () => {
    const a = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(generateWebhookSecret()).not.toBe(a);
  });
});

import { describe, expect, it } from 'vitest';
import {
  assertMayChangeRole,
  generateInvitationToken,
  hashInvitationToken,
  invitationStatus,
  personalWorkspaceName,
} from './service.js';

describe('workspace service rules', () => {
  it('names the personal workspace after the first name', () => {
    expect(personalWorkspaceName('Ada Lovelace')).toBe("Ada's workspace");
    expect(personalWorkspaceName('  ')).toBe('My workspace');
    expect(personalWorkspaceName(null)).toBe('My workspace');
  });

  it('lets only owners grant, change or remove owner (H6)', () => {
    expect(() => assertMayChangeRole('creator', 'editor', 'creator')).not.toThrow();
    expect(() => assertMayChangeRole('creator', null, 'owner')).toThrow(/Only owners/);
    expect(() => assertMayChangeRole('creator', 'owner', 'editor')).toThrow(/Only owners/);
    expect(() => assertMayChangeRole('creator', 'owner', null)).toThrow(/Only owners/);
    expect(() => assertMayChangeRole('owner', null, 'owner')).not.toThrow();
  });

  it('derives the invitation status, revoked and accepted before expired', () => {
    const now = new Date('2026-10-25T12:00:00Z');
    const base = {
      revokedAt: null,
      acceptedAt: null,
      expiresAt: new Date('2026-10-26T00:00:00Z'),
    } as Parameters<typeof invitationStatus>[0];
    expect(invitationStatus(base, now)).toBe('pending');
    expect(invitationStatus({ ...base, expiresAt: now }, now)).toBe('expired');
    expect(invitationStatus({ ...base, expiresAt: now, revokedAt: now }, now)).toBe('revoked');
    expect(invitationStatus({ ...base, acceptedAt: now }, now)).toBe('accepted');
  });

  it('makes 256-bit url-safe tokens and stores only their hash', () => {
    const token = generateInvitationToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashInvitationToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(generateInvitationToken()).not.toBe(token);
  });
});

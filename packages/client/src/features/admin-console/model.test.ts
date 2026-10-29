import type { AdminMember } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { accessText, checkPolicies, filterMembers, lastActiveText, parseDomains } from './model';

const member = (over: Partial<AdminMember> = {}): AdminMember => ({
  userId: '00000000-0000-7000-8000-000000000001',
  name: 'Ann Lee',
  email: 'ann@acme.test',
  workspaceRole: 'editor',
  bases: [],
  baseCount: 0,
  interfaceCount: 0,
  lastActiveAt: null,
  provisioned: false,
  ...over,
});

const on = { shareLinks: true, publicForms: true, embeds: true, personalAccessTokens: true };

describe('admin console model (#160)', () => {
  it('reads domains from lines, commas and @-prefixed entries', () => {
    expect(parseDomains(' Acme.test\n@eu.acme.test, other.test ;\n\n')).toEqual([
      'acme.test',
      'eu.acme.test',
      'other.test',
    ]);
  });

  it('checks the policies as the server does', () => {
    expect(checkPolicies({ ...on, domains: 'acme.test acme.test' })).toEqual({
      ok: true,
      policies: { ...on, inviteDomains: ['acme.test'] },
    });
    expect(checkPolicies({ ...on, domains: 'acme.test localhost' })).toEqual({
      ok: false,
      error: '"localhost" isn\'t a domain like example.com.',
    });
  });

  it('says when people were last active', () => {
    const now = Date.parse('2026-10-29T12:00:00Z');
    const ago = (m: number) => new Date(now - m * 60_000).toISOString();
    expect(lastActiveText(null, now)).toBe('Never');
    expect(lastActiveText(ago(5), now)).toBe('Just now');
    expect(lastActiveText(ago(40), now)).toBe('40 minutes ago');
    expect(lastActiveText(ago(60), now)).toBe('1 hour ago');
    expect(lastActiveText(ago(60 * 30), now)).toBe('Yesterday');
    expect(lastActiveText(ago(60 * 24 * 3), now)).toBe('3 days ago');
  });

  it('describes access and filters by name or email', () => {
    expect(accessText(member())).toBe('');
    expect(accessText(member({ baseCount: 2, interfaceCount: 1 }))).toBe('2 bases, 1 interface');
    const list = [member(), member({ name: null, email: 'bob@other.test' })];
    expect(filterMembers(list, 'ANN').map((m) => m.email)).toEqual(['ann@acme.test']);
    expect(filterMembers(list, 'other')).toHaveLength(1);
    expect(filterMembers(list, ' ')).toHaveLength(2);
  });
});

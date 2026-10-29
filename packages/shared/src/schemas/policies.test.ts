import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_POLICIES,
  inviteDomainAllowed,
  isDefaultPolicies,
  POLICY_INVITE_DOMAINS_MAX,
  workspacePoliciesSchema,
} from './policies.js';

describe('workspace policies (#160)', () => {
  it('defaults to allowing everything', () => {
    expect(workspacePoliciesSchema.parse(DEFAULT_WORKSPACE_POLICIES)).toEqual(
      DEFAULT_WORKSPACE_POLICIES
    );
    expect(isDefaultPolicies(DEFAULT_WORKSPACE_POLICIES)).toBe(true);
    expect(isDefaultPolicies({ ...DEFAULT_WORKSPACE_POLICIES, embeds: false })).toBe(false);
    expect(isDefaultPolicies({ ...DEFAULT_WORKSPACE_POLICIES, inviteDomains: ['a.com'] })).toBe(
      false
    );
  });

  it('normalizes invite domains and refuses bad ones, duplicates and too many', () => {
    const parse = (inviteDomains: string[]) =>
      workspacePoliciesSchema.safeParse({ ...DEFAULT_WORKSPACE_POLICIES, inviteDomains });
    expect(parse([' Example.COM ']).data?.inviteDomains).toEqual(['example.com']);
    expect(parse(['localhost']).success).toBe(false);
    expect(parse(['a@b.com']).success).toBe(false);
    expect(parse(['a.com', 'A.com']).success).toBe(false);
    const many = Array.from({ length: POLICY_INVITE_DOMAINS_MAX + 1 }, (_, i) => `d${i}.com`);
    expect(parse(many).success).toBe(false);
    // Strict: unknown keys are refused, every key is required.
    expect(
      workspacePoliciesSchema.safeParse({ ...DEFAULT_WORKSPACE_POLICIES, extra: true }).success
    ).toBe(false);
    expect(workspacePoliciesSchema.safeParse({ shareLinks: false }).success).toBe(false);
  });

  it('matches invitation addresses by their exact domain', () => {
    expect(inviteDomainAllowed([], 'anyone@anywhere.test')).toBe(true);
    expect(inviteDomainAllowed(['acme.com'], 'ann@acme.com')).toBe(true);
    expect(inviteDomainAllowed(['acme.com'], 'ann@ACME.com')).toBe(true);
    expect(inviteDomainAllowed(['acme.com'], 'ann@eu.acme.com')).toBe(false);
    expect(inviteDomainAllowed(['acme.com'], 'ann@acme.com.evil.test')).toBe(false);
    expect(inviteDomainAllowed(['acme.com'], 'acme.com')).toBe(false);
  });
});

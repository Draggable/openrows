import {
  type AdminMember,
  POLICY_INVITE_DOMAINS_MAX,
  type UserRole,
  type WorkspacePolicies,
  workspacePoliciesSchema,
} from '@openrows/shared';

/** The admin console's role names. */
export const ROLE_NAMES: Record<UserRole, string> = {
  owner: 'Owner',
  creator: 'Creator',
  editor: 'Editor',
  commenter: 'Commenter',
  read_only: 'Read only',
};

/** The on/off policies, in the console's order, with what each one does. */
export const POLICY_SWITCHES: {
  key: Exclude<keyof WorkspacePolicies, 'inviteDomains'>;
  label: string;
  help: string;
}[] = [
  {
    key: 'shareLinks',
    label: 'Allow public share links of views and bases',
    help: "Off: no one can create a share link, and existing links stop opening until it's on again.",
  },
  {
    key: 'publicForms',
    label: 'Allow public forms',
    help: "Off: form links can't be created, and published forms stop accepting answers.",
  },
  {
    key: 'embeds',
    label: 'Allow embedding share links on other sites',
    help: "Off: share links can't get embed origins, and no other site can frame them.",
  },
  {
    key: 'personalAccessTokens',
    label: 'Allow personal access tokens',
    help: "Off: the REST API, the SDK, MCP clients and n8n can't reach this workspace with a token. Signed-in people aren't affected.",
  },
];

/** The invite domains as the form's text: one per line. */
export function domainsText(domains: readonly string[]): string {
  return domains.join('\n');
}

/** The form's domains text, split on commas, spaces and lines. */
export function parseDomains(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

/** The form's policies, checked as the server will; the first problem, or the policies. */
export function checkPolicies(
  form: Omit<WorkspacePolicies, 'inviteDomains'> & { domains: string }
): { ok: true; policies: WorkspacePolicies } | { ok: false; error: string } {
  const { domains, ...switches } = form;
  const inviteDomains = [...new Set(parseDomains(domains))];
  if (inviteDomains.length > POLICY_INVITE_DOMAINS_MAX) {
    return { ok: false, error: `At most ${POLICY_INVITE_DOMAINS_MAX} domains.` };
  }
  const parsed = workspacePoliciesSchema.safeParse({ ...switches, inviteDomains });
  if (!parsed.success) {
    const bad = inviteDomains.find(
      (d) => !workspacePoliciesSchema.shape.inviteDomains.element.safeParse(d).success
    );
    return {
      ok: false,
      error: bad ? `"${bad}" isn't a domain like example.com.` : 'Check the domains.',
    };
  }
  return { ok: true, policies: parsed.data };
}

/** "Just now", "12 minutes ago", "3 days ago", or the date; "Never" without activity. */
export function lastActiveText(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'Never';
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 15) return 'Just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return days === 1 ? 'Yesterday' : `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** What a person can reach: their workspace role, or the bases and interfaces they're on. */
export function accessText(m: AdminMember): string {
  const parts: string[] = [];
  if (m.baseCount > 0) parts.push(m.baseCount === 1 ? '1 base' : `${m.baseCount} bases`);
  if (m.interfaceCount > 0) {
    parts.push(m.interfaceCount === 1 ? '1 interface' : `${m.interfaceCount} interfaces`);
  }
  return parts.join(', ');
}

/** The members matching a search by name or email (case-insensitive). */
export function filterMembers(members: readonly AdminMember[], query: string): AdminMember[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...members];
  return members.filter(
    (m) => m.email.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q)
  );
}

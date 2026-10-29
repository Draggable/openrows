import { BlockList, isIP } from 'node:net';

/**
 * Which IP addresses an outbound request to a user-chosen URL may reach (review H1/H2).
 *
 * IPv4: everything except the special-purpose ranges below. IPv6: only global unicast
 * (2000::/3), minus the special-purpose ranges inside it (the ones that embed an IPv4 address,
 * like 6to4, Teredo and NAT64, would otherwise tunnel to a private one). Everything outside
 * 2000::/3 is refused, which covers ::, ::1, IPv4-mapped (::ffff:0:0/96) and IPv4-compatible
 * addresses, ULAs (fc00::/7, incl. AWS's metadata fd00:ec2::254), link-local and multicast.
 */
const BLOCKED_V4: [string, number, string][] = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  // CGNAT, which includes Tailscale's 100.64.0.0/10 tailnet addresses.
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  // Link-local, incl. the cloud metadata service 169.254.169.254.
  ['169.254.0.0', 16, 'link-local'],
  // Docker's default bridge (172.17/16) and address pools (172.17-31/16, 192.168/16) are here.
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'special-purpose'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4 relay'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

const BLOCKED_V6: [string, number, string][] = [
  ['2001::', 23, 'special-purpose'],
  ['2001:db8::', 32, 'documentation'],
  ['2002::', 16, '6to4'],
  ['3fff::', 20, 'documentation'],
];

/** Refused even when an allowlist entry matches: the cloud metadata services. */
const METADATA = new Set(['169.254.169.254', 'fd00:ec2::254', '100.100.100.200']);

const v4 = new BlockList();
const v4Reasons: [BlockList, string][] = [];
for (const [net, prefix, reason] of BLOCKED_V4) {
  v4.addSubnet(net, prefix, 'ipv4');
  const one = new BlockList();
  one.addSubnet(net, prefix, 'ipv4');
  v4Reasons.push([one, reason]);
}
const globalUnicast = new BlockList();
globalUnicast.addSubnet('2000::', 3, 'ipv6');
const v6Reasons: [BlockList, string][] = BLOCKED_V6.map(([net, prefix, reason]) => {
  const one = new BlockList();
  one.addSubnet(net, prefix, 'ipv6');
  return [one, reason];
});

/** The address in canonical form (lowercase, IPv6 compressed), or null when it isn't an IP. */
export function canonicalIp(value: string): string | null {
  const bare = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  const family = isIP(bare);
  if (family === 4) return bare;
  if (family === 6) return new URL(`http://[${bare}]/`).hostname.slice(1, -1);
  return null;
}

/** Why `ip` must not be reached (`loopback`, `private`, ...), or null when it's public. */
export function blockedReason(ip: string): string | null {
  const address = canonicalIp(ip);
  if (address === null) return 'not an IP address';
  if (isIP(address) === 4) {
    if (!v4.check(address, 'ipv4')) return null;
    return v4Reasons.find(([list]) => list.check(address, 'ipv4'))?.[1] ?? 'reserved';
  }
  if (address.startsWith('::ffff:')) return 'IPv4-mapped';
  if (!globalUnicast.check(address, 'ipv6')) {
    if (address === '::') return 'unspecified';
    if (address === '::1') return 'loopback';
    if (/^f[cd]/.test(address)) return 'private';
    if (/^fe[89ab]/.test(address)) return 'link-local';
    if (address.startsWith('ff')) return 'multicast';
    return 'reserved';
  }
  return v6Reasons.find(([list]) => list.check(address, 'ipv6'))?.[1] ?? null;
}

export function isMetadataAddress(ip: string): boolean {
  const address = canonicalIp(ip);
  return address !== null && METADATA.has(address);
}

/**
 * A self-hoster's allow- or denylist (`OUTBOUND_HTTP_ALLOW`, `OUTBOUND_HTTP_DENY`): IPs, CIDRs
 * and hostnames. A hostname matches itself exactly; `*.example.com` matches its subdomains.
 */
export class AddressRules {
  readonly #ips = new BlockList();
  readonly #hosts = new Set<string>();
  readonly #suffixes: string[] = [];
  readonly size: number;

  constructor(entries: readonly string[]) {
    for (const entry of entries) {
      const rule = parseRule(entry);
      if (rule.kind === 'cidr') this.#ips.addSubnet(rule.network, rule.prefix, rule.family);
      else if (rule.kind === 'suffix') this.#suffixes.push(rule.suffix);
      else this.#hosts.add(rule.host);
    }
    this.size = entries.length;
  }

  matchesHost(hostname: string): boolean {
    const host = normalizeHostname(hostname);
    return this.#hosts.has(host) || this.#suffixes.some((s) => host.endsWith(s));
  }

  matchesIp(ip: string): boolean {
    const address = canonicalIp(ip);
    if (address === null) return false;
    return this.#ips.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
  }
}

type Rule =
  | { kind: 'cidr'; network: string; prefix: number; family: 'ipv4' | 'ipv6' }
  | { kind: 'host'; host: string }
  | { kind: 'suffix'; suffix: string };

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/;

/** Lowercase, without the trailing dot of a fully qualified name. */
export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, '');
}

/** Parses one list entry; throws with a readable message (config validation shows it). */
export function parseRule(entry: string): Rule {
  const value = entry.trim().toLowerCase();
  const [address = '', prefixText, ...rest] = value.split('/');
  const ip = canonicalIp(address);
  if (ip !== null && rest.length === 0) {
    const family = isIP(ip) === 4 ? 'ipv4' : 'ipv6';
    const max = family === 'ipv4' ? 32 : 128;
    const prefix = prefixText === undefined ? max : Number(prefixText);
    if (!/^\d{1,3}$/.test(prefixText ?? String(max)) || prefix > max) {
      throw new Error(`"${entry}" has an invalid prefix length`);
    }
    return { kind: 'cidr', network: ip, prefix, family };
  }
  if (value.startsWith('*.') && HOSTNAME.test(value.slice(2))) {
    return { kind: 'suffix', suffix: value.slice(1) };
  }
  const host = normalizeHostname(value);
  if (HOSTNAME.test(host)) return { kind: 'host', host };
  throw new Error(`"${entry}" is not an IP address, CIDR or hostname`);
}

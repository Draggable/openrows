import { AddressRules } from './address.js';

/** The self-hoster's settings for outbound requests to user URLs (`OUTBOUND_HTTP_*`, config.ts). */
export interface OutboundConfig {
  /** Allow `http:` URLs too (`OUTBOUND_HTTP_ALLOW_HTTP`). Off: https only. */
  allowHttp: boolean;
  /** Ports allowed besides 80 and 443 (`OUTBOUND_HTTP_PORTS`). */
  extraPorts: number[];
  /** IPs, CIDRs and hostnames reachable even when private (`OUTBOUND_HTTP_ALLOW`). */
  allow: string[];
  /** IPs, CIDRs and hostnames never reached, even public ones (`OUTBOUND_HTTP_DENY`). */
  deny: string[];
}

export const DEFAULT_OUTBOUND: OutboundConfig = {
  allowHttp: false,
  extraPorts: [],
  allow: [],
  deny: [],
};

export interface OutboundPolicy {
  allowHttp: boolean;
  ports: ReadonlySet<number>;
  allow: AddressRules;
  deny: AddressRules;
}

export function outboundPolicy(config: OutboundConfig = DEFAULT_OUTBOUND): OutboundPolicy {
  return {
    allowHttp: config.allowHttp,
    ports: new Set([80, 443, ...config.extraPorts]),
    allow: new AddressRules(config.allow),
    deny: new AddressRules(config.deny),
  };
}

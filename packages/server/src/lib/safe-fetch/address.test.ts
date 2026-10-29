import { describe, expect, it } from 'vitest';
import {
  AddressRules,
  blockedReason,
  canonicalIp,
  isMetadataAddress,
  parseRule,
} from './address.js';

describe('blockedReason', () => {
  it.each([
    ['0.0.0.0', 'unspecified'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.20.30.40', 'private'],
    ['172.16.0.1', 'private'],
    ['172.17.0.2', 'private'],
    ['192.168.65.254', 'private'],
    ['169.254.169.254', 'link-local'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['100.78.12.34', 'carrier-grade NAT'],
    ['100.127.255.255', 'carrier-grade NAT'],
    ['192.0.0.170', 'special-purpose'],
    ['198.18.0.1', 'benchmarking'],
    ['224.0.0.251', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['::ffff:127.0.0.1', 'IPv4-mapped'],
    ['::ffff:8.8.8.8', 'IPv4-mapped'],
    ['::127.0.0.1', 'reserved'],
    ['64:ff9b::a9fe:a9fe', 'reserved'],
    ['fd00:ec2::254', 'private'],
    ['fc00::1', 'private'],
    ['FE80::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['2001::1', 'special-purpose'],
    ['2002:a9fe:a9fe::1', '6to4'],
    ['127.1', 'not an IP address'],
    ['example.com', 'not an IP address'],
  ])('refuses %s (%s)', (ip, reason) => {
    expect(blockedReason(ip)).toBe(reason);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '93.184.215.14',
    '100.63.255.255',
    '100.128.0.0',
    '172.15.255.255',
    '172.32.0.0',
    '2606:4700:4700::1111',
    '2a00:1450:4001:80b::200e',
  ])('allows the public address %s', (ip) => {
    expect(blockedReason(ip)).toBeNull();
  });

  it('knows the metadata services', () => {
    expect(isMetadataAddress('169.254.169.254')).toBe(true);
    expect(isMetadataAddress('[FD00:EC2:0::254]')).toBe(true);
    expect(isMetadataAddress('169.254.169.253')).toBe(false);
  });

  it('canonicalizes IPv6', () => {
    expect(canonicalIp('[FD00:0EC2:0:0:0:0:0:254]')).toBe('fd00:ec2::254');
    expect(canonicalIp('::ffff:127.0.0.1')).toBe('::ffff:7f00:1');
    expect(canonicalIp('host')).toBeNull();
  });
});

describe('AddressRules', () => {
  const rules = new AddressRules(['10.0.5.0/24', 'fd12::/64', '192.168.1.9', 'n8n.lan.', '*.corp']);

  it('matches IPs by CIDR', () => {
    expect(rules.matchesIp('10.0.5.200')).toBe(true);
    expect(rules.matchesIp('10.0.6.1')).toBe(false);
    expect(rules.matchesIp('fd12::abcd')).toBe(true);
    expect(rules.matchesIp('fd13::1')).toBe(false);
    expect(rules.matchesIp('192.168.1.9')).toBe(true);
    expect(rules.matchesIp('192.168.1.10')).toBe(false);
  });

  it('matches hostnames exactly or by a wildcard suffix', () => {
    expect(rules.matchesHost('N8N.lan')).toBe(true);
    expect(rules.matchesHost('n8n.lan.')).toBe(true);
    expect(rules.matchesHost('x.n8n.lan')).toBe(false);
    expect(rules.matchesHost('hooks.corp')).toBe(true);
    expect(rules.matchesHost('corp')).toBe(false);
    expect(rules.matchesHost('evilcorp')).toBe(false);
  });

  it('rejects malformed entries', () => {
    for (const bad of [
      '10.0.0.0/33',
      '::/129',
      '10.0.0.0/x',
      'http://x',
      'a b',
      '*',
      '1.2.3.4/8/1',
    ]) {
      expect(() => parseRule(bad), bad).toThrow();
    }
  });
});

/**
 * URLs the safe client refuses by address alone, whatever the scheme and port rules allow (the
 * SSRF suite, #106): loopback in every spelling, private, link-local, CGNAT, multicast and
 * metadata ranges, IPv4-mapped and translated IPv6. Shared by fetch.test.ts and the integration
 * tests of everything that requests user URLs (webhooks, automations' HTTP and Slack steps).
 * Policy for them: http allowed, port 8080 allowed, nothing allowlisted.
 */
export const REFUSED_URLS: readonly string[] = [
  'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
  'http://[fd00:ec2::254]/latest/meta-data/',
  'http://localhost/',
  'http://LOCALHOST./',
  'http://api.localhost/',
  'http://127.0.0.1/',
  'http://127.1/',
  'http://0x7f000001/',
  'http://0x7f.0.0.1/',
  'http://0177.0.0.1/',
  'http://2130706433/',
  'http://017700000001/',
  'http://0/',
  'http://0.0.0.0/',
  'http://[::]/',
  'http://[::1]/',
  'http://[0:0:0:0:0:0:0:1]/',
  'http://[::ffff:127.0.0.1]/',
  'http://[::ffff:a9fe:a9fe]/',
  'http://[64:ff9b::7f00:1]/',
  'http://[2002:7f00:1::]/',
  'http://100.78.12.34/',
  'http://100.100.100.200/',
  'http://10.0.0.1/',
  'http://172.17.0.1/',
  'http://172.31.255.254/',
  'http://192.168.1.1/',
  'http://[fe80::1]/',
  'http://[fc00::1]/',
  'http://224.0.0.1/',
  'http://255.255.255.255/',
  'http://192.0.2.1:8080/',
];

import { createHash } from 'node:crypto';

/** A name-based UUID (version 5 layout, SHA-1) for a job id that must be the same every time. */
export function namedJobId(name: string): string {
  const hash = createHash('sha1').update(name).digest();
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

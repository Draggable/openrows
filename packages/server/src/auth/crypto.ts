import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for secrets the server keeps: OIDC refresh and ID tokens in `sessions` and the
 * short-lived login-transaction cookie. Each purpose gets its own key, derived from
 * ENCRYPTION_KEY with HKDF, so a ciphertext made for one purpose never decrypts as another.
 *
 * Layout: version (1 byte) | IV (12) | auth tag (16) | ciphertext.
 */

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type CipherPurpose =
  | 'session-tokens'
  | 'login-transaction'
  | 'webhook-secret'
  /** Automations' secrets and webhook-received tokens. */
  | 'automation-secret'
  /** Airtable personal access tokens, kept for an import job. */
  | 'airtable-token'
  /** Workspaces' own AI provider keys. */
  | 'ai-key'
  /** The audit log's SIEM stream signing secrets. */
  | 'audit-stream'
  /** Synced tables' CSV URLs and Postgres connection strings. */
  | 'sync-source'
  /** Sync connector accounts' OAuth tokens. */
  | 'sync-connector-tokens'
  /** The short-lived cookie of a sync connector's OAuth flow. */
  | 'sync-connector-state';

export interface Cipher {
  encrypt(plaintext: string): Buffer;
  /** Returns undefined when the data was tampered with, truncated or made with another key. */
  decrypt(data: Buffer): string | undefined;
}

export function createCipher(secret: string, purpose: CipherPurpose): Cipher {
  const key = Buffer.from(hkdfSync('sha256', secret, 'openrows', `openrows:${purpose}`, 32));
  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
    },
    decrypt(data) {
      if (data.length < 1 + IV_BYTES + TAG_BYTES || data[0] !== VERSION) return undefined;
      const iv = data.subarray(1, 1 + IV_BYTES);
      const tag = data.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const body = data.subarray(1 + IV_BYTES + TAG_BYTES);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
      } catch {
        return undefined;
      }
    },
  };
}

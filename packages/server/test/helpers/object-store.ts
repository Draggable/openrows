import { concatBytes, type ObjectStore } from '../../src/attachments/storage.js';

/** An in-memory object store for tests that don't need real S3 (the authz matrix). */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();

  async presignPut(key: string) {
    return { url: `https://s3.test/${key}?X-Amz-Signature=put`, headers: {} };
  }
  async presignGet(key: string) {
    return `https://s3.test/${key}?X-Amz-Signature=get`;
  }
  async head(key: string) {
    const body = this.objects.get(key);
    return body ? { size: body.byteLength } : null;
  }
  async get(key: string) {
    const body = this.objects.get(key);
    if (!body) throw new Error(`no object ${key}`);
    return body;
  }
  async put(key: string, body: Uint8Array) {
    this.objects.set(key, body);
  }
  async putStream(key: string, body: AsyncIterable<Uint8Array>) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of body) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    this.objects.set(key, concatBytes(chunks, total));
    return total;
  }
  async getStream(key: string): Promise<AsyncIterable<Uint8Array>> {
    const body = await this.get(key);
    return (async function* () {
      // In slices, like a network stream.
      for (let i = 0; i < body.byteLength; i += 64 * 1024) yield body.subarray(i, i + 64 * 1024);
    })();
  }
  async copy(from: string, to: string) {
    const body = this.objects.get(from);
    if (!body) throw new Error(`no object ${from}`);
    this.objects.set(to, body.slice());
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async *list(prefix: string) {
    for (const key of [...this.objects.keys()].sort()) if (key.startsWith(prefix)) yield key;
  }
}

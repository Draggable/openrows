import { lookup } from 'node:dns/promises';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll } from 'vitest';
import type { S3Config } from '../../src/config.js';
import { VERSITY_IMAGE } from './images.js';

/**
 * A real S3 server for the file's tests: Versity S3 Gateway on its posix backend, the
 * same image as docker/dev.yml, with one bucket. `s3()` gives the config once it has started.
 */
export function useTestS3(opts: { metadata?: boolean } = {}): () => S3Config {
  let container: StartedTestContainer | undefined;
  let config: S3Config | undefined;
  beforeAll(async () => {
    container = await new GenericContainer(VERSITY_IMAGE)
      .withEnvironment({ ROOT_ACCESS_KEY: 'test-access', ROOT_SECRET_KEY: 'test-secret-key' })
      .withEntrypoint(['sh', '-c'])
      // `--nometa` keeps no xattrs, and with them no part ETags: multipart uploads need
      // the metadata.
      .withCommand([
        `mkdir -p /data/openrows && exec versitygw --port :9000 posix ${opts.metadata ? '' : '--nometa '}/data`,
      ])
      .withExposedPorts(9000)
      .start();
    // Dial the address getHost() resolves to (see email.test.ts: IPv4 and IPv6 may map apart).
    const { address, family } = await lookup(container.getHost());
    const host = family === 6 ? `[${address}]` : address;
    config = {
      endpoint: `http://${host}:${container.getMappedPort(9000)}`,
      region: 'us-east-1',
      bucket: 'openrows',
      accessKey: 'test-access',
      secretKey: 'test-secret-key',
      publicUrl: undefined,
    };
  }, 120_000);
  afterAll(async () => {
    await container?.stop();
  });
  return () => {
    if (!config) throw new Error('useTestS3: the S3 server has not started');
    return config;
  };
}

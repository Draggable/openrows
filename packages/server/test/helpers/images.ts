import { getContainerRuntimeClient, ImageName } from 'testcontainers';
import { DEFAULT_SCRIPT_IMAGE } from '../../src/automations/script/types.js';

/** Every image the integration suite starts, so global-setup.ts can pull them up front. */
export const POSTGRES_IMAGE = 'postgres:16-alpine';
export const REDIS_IMAGE = 'redis:7-alpine';
// Same image as docker/dev.yml.
export const MAILPIT_IMAGE =
  'axllent/mailpit:v1.31.2@sha256:74d609a42ec279aa63c6b4622a6fa9b5408d1ad5b1d76a1c4be40a265ce0863d';
// Same image as docker/dev.yml: the S3 server for attachments.
export const VERSITY_IMAGE =
  'versity/versitygw:v1.10.0@sha256:89cad13cc981986ee284cbafea4613f9533ce6fd5f37a2c96c4c4fb8adb3a316';
// Run-script steps' sandbox: the server's default script image.
export const SCRIPT_IMAGE = DEFAULT_SCRIPT_IMAGE;
export const TEST_IMAGES = [
  POSTGRES_IMAGE,
  REDIS_IMAGE,
  MAILPIT_IMAGE,
  VERSITY_IMAGE,
  SCRIPT_IMAGE,
];

const ATTEMPTS = 3;

/**
 * Pulls each image and checks it really is on the Docker host, retrying a few times.
 *
 * Testcontainers treats a pull as done when Docker's progress stream ends, and ignores the
 * `{"error": ...}` lines in it (a registry rate limit, a dropped connection, a full disk). The
 * container create then fails with a bare "No such image". On the shared CI runners another job
 * can also prune images between a pull and a create. Checking here turns both into a retry, or
 * into an error that says what happened.
 */
export async function ensureImages(images: readonly string[]): Promise<void> {
  const client = await getContainerRuntimeClient();
  for (const image of images) {
    const name = ImageName.fromString(image);
    let lastError: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        await client.image.pull(name, { force: attempt > 1, platform: undefined });
        // inspect, not exists(): exists() caches positive answers for the whole process.
        await client.image.inspect(name);
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 3_000));
      }
    }
    if (lastError !== undefined) {
      throw new Error(
        `Could not pull Docker image ${image} after ${ATTEMPTS} attempts. If the last error is ` +
          `"No such image", Docker ended the pull without the image: run \`docker pull ${image}\` ` +
          'on the same host to see the registry error. Last error: ' +
          (lastError instanceof Error ? lastError.message : String(lastError)),
        { cause: lastError }
      );
    }
  }
}

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** `source` formatted by Biome with the repository's settings, as the file at `path` would be. */
export function biomeFormat(source: string, path: string): string {
  return execFileSync('node_modules/.bin/biome', ['format', `--stdin-file-path=${path}`], {
    cwd: ROOT,
    input: source,
    encoding: 'utf8',
  });
}

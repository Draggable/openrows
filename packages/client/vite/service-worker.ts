import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'vite';

const clientRoot = fileURLToPath(new URL('..', import.meta.url));

/** Public files that aren't part of the app shell (link previews only). */
const NOT_PRECACHED = /^\/og-image|\.map$/;

function publicFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `/${relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/')}`);
}

/**
 * Emits the service worker as /sw.js: src/sw/worker.ts bundled on its own (one classic
 * script, no imports), with the build's precache list (index.html, every emitted chunk, style
 * and font, the icons and manifest) and a build id from their names and contents, so each
 * deploy installs a new worker and drops the old shell. Only in `vite build`; `vite dev` has
 * no worker.
 */
export function serviceWorker(): Plugin {
  let publicDir = '';
  return {
    name: 'openrows-service-worker',
    apply: 'build',
    configResolved(config) {
      publicDir = config.publicDir;
    },
    async generateBundle(_options, bundle) {
      const hash = createHash('sha256');
      const files = new Set<string>(['/index.html']);
      for (const [fileName, _output] of Object.entries(bundle)) {
        const path = `/${fileName}`;
        if (NOT_PRECACHED.test(path) || fileName === 'index.html') continue;
        files.add(path);
      }
      const statics = publicDir ? publicFiles(publicDir) : [];
      for (const path of statics) {
        if (NOT_PRECACHED.test(path)) continue;
        files.add(path);
        hash.update(path).update(readFileSync(join(publicDir, path)));
      }
      const index = bundle['index.html'];
      if (index?.type === 'asset') hash.update(index.source);
      const precache = [...files].sort();
      hash.update(precache.join('\n'));
      const buildId = hash.digest('hex').slice(0, 16);

      const result = await build({
        configFile: false,
        root: clientRoot,
        logLevel: 'warn',
        publicDir: false,
        define: {
          __OPENROWS_PRECACHE__: JSON.stringify(precache),
          __OPENROWS_BUILD__: JSON.stringify(buildId),
        },
        build: {
          write: false,
          minify: true,
          emptyOutDir: false,
          lib: {
            entry: join(clientRoot, 'src/sw/worker.ts'),
            formats: ['iife'],
            name: 'openrowsServiceWorker',
            fileName: () => 'sw.js',
          },
        },
      });
      const outputs = Array.isArray(result) ? result : [result];
      const chunk = outputs
        .flatMap((o) => ('output' in o ? o.output : []))
        .find((o) => o.type === 'chunk');
      if (chunk?.type !== 'chunk') throw new Error('The service worker build emitted no chunk');
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: chunk.code });
    },
  };
}

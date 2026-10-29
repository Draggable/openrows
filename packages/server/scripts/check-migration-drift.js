// Fails when src/db/schema.ts and the committed migrations in drizzle/ disagree: it runs
// `drizzle-kit generate` and checks that nothing in drizzle/ was added or changed.
// Run with `npm run db:check` (CI runs it). If it fails, run `npm run db:generate` and commit.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = fileURLToPath(new URL('..', import.meta.url));
const migrationsDir = join(serverDir, 'drizzle');

function snapshot() {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else
        files.set(
          relative(serverDir, path),
          createHash('sha256').update(readFileSync(path)).digest('hex')
        );
    }
  };
  walk(migrationsDir);
  return files;
}

const before = snapshot();
execFileSync('npx', ['drizzle-kit', 'generate'], { cwd: serverDir, stdio: 'inherit' });
const after = snapshot();

const changed = [...after].filter(([file, hash]) => before.get(file) !== hash).map(([f]) => f);
if (changed.length > 0) {
  console.error(
    `\nMigration drift: drizzle-kit generate changed ${changed.join(', ')}.\n` +
      'src/db/schema.ts has changes without a migration. Run `npm run db:generate` and commit the result.'
  );
  process.exit(1);
}
console.log('No migration drift: schema.ts matches drizzle/.');

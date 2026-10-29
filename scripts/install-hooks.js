// Runs from the root `prepare` script on every `npm install`/`npm ci`. Installs the lefthook git
// hooks for contributors, and skips quietly where hooks make no sense: Docker builds (no .git),
// CI, and production installs (`--omit=dev`, so lefthook isn't installed).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function hasLefthook() {
  try {
    require.resolve('lefthook/package.json');
    return true;
  } catch {
    return false;
  }
}

if (process.env.CI || !existsSync('.git') || !hasLefthook()) {
  console.log('install-hooks: skipping lefthook install');
} else {
  execFileSync('npx', ['--no-install', 'lefthook', 'install'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

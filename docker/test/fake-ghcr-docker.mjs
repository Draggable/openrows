#!/usr/bin/env node
// A fake `docker` for docker/ghcr.sh and deploy.sh's OPENROWS_NO_BUILD (ghcr.test.ts):
// appends every call as a JSON line { args, config, stdin } to $FAKE_DOCKER_CALLS (`config` is
// $DOCKER_CONFIG, `stdin` what `login --password-stdin` read). `image inspect --format` prints
// $FAKE_REVISION; a bare `image inspect` fails when $FAKE_IMAGE_MISSING is set; `pull` fails
// when $FAKE_PULL_FAIL is set. Everything else succeeds.
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const stdin = args.includes('--password-stdin') ? readFileSync(0, 'utf8') : undefined;
appendFileSync(
  process.env.FAKE_DOCKER_CALLS ?? '/dev/null',
  `${JSON.stringify({ args, config: process.env.DOCKER_CONFIG ?? null, stdin })}\n`
);
if (args[0] === 'image' && args[1] === 'inspect') {
  if (args.includes('--format')) console.log(process.env.FAKE_REVISION ?? '');
  else if (process.env.FAKE_IMAGE_MISSING) process.exit(1);
}
if (args[0] === 'pull' && process.env.FAKE_PULL_FAIL) process.exit(1);

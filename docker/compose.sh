#!/usr/bin/env bash
# docker/compose.sh <dev|ci> <docker compose args...>
#
# Runs docker compose with the base file + the env overlay, the project name openrows-<env>
# (its own containers, volumes and network per env) and the env file. For a production stack of
# your own, see docs/guide/self-hosting.md ("A production stack").
#
# ci is CI's smoke stack: dev.yml plus ci.yml (no host ports, Playwright inside the stack), with
# the project openrows-ci-<OPENROWS_CI_ID> so concurrent runs on one Docker host stay apart, and
# always the dev template as env file (a developer's docker/.env.dev doesn't change it).
#
# The env file is docker/.env.<env> (git-ignored; copy docker/.env.<env>.example), unless
# OPENROWS_ENV_FILE points elsewhere. dev falls back to docker/.env.dev.example, whose values are
# all development defaults.
#
#   docker/compose.sh dev up -d --wait        # build + start the dev stack (http://localhost:8180)
#   docker/compose.sh dev config              # render the effective config
#   docker/compose.sh dev logs -f api
#   docker/compose.sh dev down -v             # stop and drop the dev volumes
set -euo pipefail

env="${1:-}"
case "$env" in
  dev|ci) ;;
  *) echo "usage: docker/compose.sh <dev|ci> <docker compose args...>" >&2; exit 2 ;;
esac
shift

here="$(cd "$(dirname "$0")" && pwd)"
project="openrows-$env"
overlays=("$env.yml")
if [ "$env" = ci ]; then
  ci_id="${OPENROWS_CI_ID:?set OPENROWS_CI_ID (CI: <run id>-<attempt>; locally e.g. local)}"
  if ! [[ "$ci_id" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    echo "OPENROWS_CI_ID must be lowercase letters, digits, _ and -: $ci_id" >&2
    exit 2
  fi
  project="openrows-ci-$ci_id"
  overlays=(dev.yml ci.yml)
fi
env_file="${OPENROWS_ENV_FILE:-$here/.env.$env}"
if [ -z "${OPENROWS_ENV_FILE:-}" ] && [ "$env" = ci ]; then
  env_file="$here/.env.dev.example"
fi
if [ -z "${OPENROWS_ENV_FILE:-}" ] && [ "$env" = dev ] && [ ! -f "$env_file" ]; then
  env_file="$here/.env.dev.example"
fi
if [ ! -f "$env_file" ]; then
  echo "missing env file: $env_file (copy $here/.env.$env.example and fill it in; or set OPENROWS_ENV_FILE)" >&2
  exit 1
fi

files="$here"

args=(-f "$files/compose.yml")
for overlay in "${overlays[@]}"; do args+=(-f "$files/$overlay"); done

exec docker compose \
  --project-name "$project" \
  --env-file "$env_file" \
  "${args[@]}" \
  "$@"

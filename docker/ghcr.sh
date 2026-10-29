#!/usr/bin/env bash
# docker/ghcr.sh: the GHCR side of CI's images and the prod deploy.
#
#   docker/ghcr.sh push [--private] <local image> <repository> <commit>
#   docker/ghcr.sh pull <repository> <commit> <local tag>
#   docker/ghcr.sh check-private <repository> <tag>
#
# push (CI's docker job, main only): tags <local image> as <repository>:sha-<commit>, pushes it,
# then points <repository>:main at it registry-side, only while <commit> is still main's tip (a
# slower run of an older commit can't move it back). With --private (an image whose license forbids
# redistribution, such as the hosted edition's) it refuses to push when the package answers anonymous
# reads, and fails after the push (without moving :main) if the pushed tag does.
#
# pull (a deploy workflow): pulls <repository>:sha-<commit>, refuses it unless its
# org.opencontainers.image.revision label is <commit>, and tags it <local tag>
# (openrows:sha-<commit>, what docker/deploy.sh runs). The registry tag is removed again.
#
# check-private: exits 0 when <repository>:<tag> can't be read without credentials, 1 when it
# can, 3 when the registry's answer says neither.
#
# push and pull log in with $GH_TOKEN (the job's GITHUB_TOKEN; packages: write for push, read for
# pull) in a private DOCKER_CONFIG that is deleted on exit, so the host's ~/.docker logins (other
# jobs', the host's own) are never read or changed. The token goes through stdin only: never an
# argument, never printed. GHCR_URL overrides https://ghcr.io for the anonymous checks and
# GHCR_RETRY_DELAY the 5 s between pull attempts (tests).
set -euo pipefail

registry_url="${GHCR_URL:-https://ghcr.io}"
api_url="${GITHUB_API_URL:-https://api.github.com}"
manifest_types='application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json'

usage() {
  sed -n '4,6p' "$0" | sed 's/^# *//' >&2
  exit 2
}

check_commit() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || { echo "ghcr.sh: not a full commit sha: $1" >&2; exit 2; }
}

check_repository() {
  [[ "$1" =~ ^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+$ ]] || { echo "ghcr.sh: not a repository: $1" >&2; exit 2; }
}

cleanup_tags=()
docker_config=''
cleanup() {
  for tag in "${cleanup_tags[@]}"; do
    docker image rm "$tag" >/dev/null 2>&1 || true
  done
  if [ -n "$docker_config" ]; then rm -rf "$docker_config"; fi
}
trap cleanup EXIT

login() {
  if [ -z "${GH_TOKEN:-}" ]; then
    echo "ghcr.sh: set GH_TOKEN (the job's GITHUB_TOKEN)" >&2
    exit 2
  fi
  docker_config=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ghcr-docker-config.XXXXXX")
  export DOCKER_CONFIG="$docker_config"
  # Keep the user's CLI plugins (buildx for imagetools) visible.
  if [ -d "$HOME/.docker/cli-plugins" ]; then
    ln -s "$HOME/.docker/cli-plugins" "$DOCKER_CONFIG/cli-plugins"
  fi
  printf '%s\n' "$GH_TOKEN" |
    docker login "${1%%/*}" -u "${GITHUB_ACTOR:-github-actions}" --password-stdin >/dev/null
}

# The HTTP status of an anonymous manifest request for <repository>:<tag>, with the anonymous
# pull token the registry hands out for public packages (none for private ones).
anonymous_status() {
  local path="${1#*/}" tag="$2" token
  local auth=()
  token=$(curl -fsS --max-time 20 "$registry_url/token?scope=repository:$path:pull" 2>/dev/null |
    sed -n 's/.*"token" *: *"\([^"]*\)".*/\1/p') || token=''
  if [ -n "$token" ]; then auth=(-H @-); fi
  printf 'Authorization: Bearer %s\n' "$token" |
    curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "${auth[@]}" \
      -H "Accept: $manifest_types" "$registry_url/v2/$path/manifests/$tag" 2>/dev/null || true
}

check_private() {
  local code
  code=$(anonymous_status "$1" "$2")
  case "$code" in
    401 | 403 | 404) return 0 ;;
    200) echo "ghcr.sh: $1:$2 can be pulled without credentials: the package is public" >&2; return 1 ;;
    *) echo "ghcr.sh: could not tell whether $1:$2 is private (anonymous read answered ${code:-nothing})" >&2; return 3 ;;
  esac
}

main_tip() {
  printf 'Authorization: Bearer %s\n' "$GH_TOKEN" |
    curl -fsSL --max-time 20 -H @- -H 'Accept: application/vnd.github.sha' \
      "$api_url/repos/${GITHUB_REPOSITORY:?set GITHUB_REPOSITORY}/commits/main"
}

push() {
  local private=false
  if [ "${1:-}" = --private ]; then private=true; shift; fi
  [ $# -eq 3 ] || usage
  local image="$1" repo="$2" commit="$3"
  check_repository "$repo"
  check_commit "$commit"
  if $private; then
    # Never add a tag to a package anyone can read. Before the first push there is no package
    # (404); GHCR creates new packages private.
    check_private "$repo" main || exit 1
  fi
  login "$repo"
  cleanup_tags+=("$repo:sha-$commit")
  docker tag "$image" "$repo:sha-$commit"
  docker push "$repo:sha-$commit"
  echo "pushed $repo:sha-$commit"
  if $private; then
    check_private "$repo" "sha-$commit" || {
      echo "ghcr.sh: make the $repo package private (package settings, Danger Zone) before anything else" >&2
      exit 1
    }
  fi
  local tip
  tip=$(main_tip)
  if [ "$tip" = "$commit" ]; then
    docker buildx imagetools create --tag "$repo:main" "$repo:sha-$commit"
    echo "$repo:main -> sha-$commit"
  else
    echo "main is at $tip now; leaving $repo:main to that commit's run"
  fi
}

pull() {
  [ $# -eq 3 ] || usage
  local repo="$1" commit="$2" tag="$3" revision attempt
  check_repository "$repo"
  check_commit "$commit"
  login "$repo"
  cleanup_tags+=("$repo:sha-$commit")
  for attempt in 1 2 3; do
    docker pull --quiet "$repo:sha-$commit" && break
    if [ "$attempt" = 3 ]; then
      echo "ghcr.sh: could not pull $repo:sha-$commit (does this job's token have read access to the package?)" >&2
      exit 1
    fi
    sleep "${GHCR_RETRY_DELAY:-5}"
  done
  revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$repo:sha-$commit")
  if [ "$revision" != "$commit" ]; then
    echo "ghcr.sh: $repo:sha-$commit was built from ${revision:-an unlabeled commit}, not $commit" >&2
    exit 1
  fi
  docker tag "$repo:sha-$commit" "$tag"
  echo "pulled $repo:sha-$commit as $tag"
}

case "${1:-}" in
  push) shift; push "$@" ;;
  pull) shift; pull "$@" ;;
  check-private)
    shift
    [ $# -eq 2 ] || usage
    check_repository "$1"
    check_private "$1" "$2"
    ;;
  *) usage ;;
esac

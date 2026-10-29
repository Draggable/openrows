#!/usr/bin/env bash
# deploy/helm/install-tools.sh <dir> [helm|kind]...: downloads the pinned Helm (and kind) the
# chart's tests use into <dir>, checked against the SHA-256 sums below (not ones fetched next to
# the download). CI runs it; locally, add <dir> to PATH or set HELM=<dir>/helm.
# Bump a version together with its sums (from the release's .sha256sum files).
set -euo pipefail

HELM_VERSION=v4.3.1
KIND_VERSION=v0.33.0

helm_sum() {
  case "$1" in
    linux-amd64) echo 0403a88ae20913d11b10a2467b50087721fea7581736da6b9d3992f5357fe54b ;;
    linux-arm64) echo 8cf8f66ecbc252ac8f7f06cca68aba88508ddfde3a6a34feb1678ad1694b4f88 ;;
    darwin-arm64) echo 6b4e61c8cd27d99e5a801e63ff25dd5c70b36875c2cd659d3e9ce6b76fc23198 ;;
    darwin-amd64) echo 34bec4eba761ba5c16d1965ee6b8f5b0abe5993974a802274e2a4f0418893d89 ;;
    *) return 1 ;;
  esac
}
kind_sum() {
  case "$1" in
    linux-amd64) echo aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d ;;
    *) return 1 ;;
  esac
}

dir="${1:?usage: install-tools.sh <dir> [helm|kind]...}"
shift
tools=("$@")
[ "${#tools[@]}" -gt 0 ] || tools=(helm)

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "unsupported machine $(uname -m)" >&2; exit 1 ;;
esac
platform="$os-$arch"

verify() { # <file> <sum>
  local actual
  actual="$(sha256sum "$1" 2>/dev/null || shasum -a 256 "$1")"
  if [ "${actual%% *}" != "$2" ]; then
    echo "checksum mismatch for $1" >&2
    exit 1
  fi
}

mkdir -p "$dir"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for tool in "${tools[@]}"; do
  case "$tool" in
    helm)
      sum="$(helm_sum "$platform")" || { echo "no pinned Helm for $platform" >&2; exit 1; }
      curl -fsSL -o "$work/helm.tgz" "https://get.helm.sh/helm-$HELM_VERSION-$platform.tar.gz"
      verify "$work/helm.tgz" "$sum"
      tar -xzf "$work/helm.tgz" -C "$work" "$platform/helm"
      install -m 0755 "$work/$platform/helm" "$dir/helm"
      ;;
    kind)
      sum="$(kind_sum "$platform")" || { echo "no pinned kind for $platform" >&2; exit 1; }
      curl -fsSL -o "$work/kind" \
        "https://github.com/kubernetes-sigs/kind/releases/download/$KIND_VERSION/kind-$platform"
      verify "$work/kind" "$sum"
      install -m 0755 "$work/kind" "$dir/kind"
      ;;
    *) echo "unknown tool $tool" >&2; exit 1 ;;
  esac
  "$dir/$tool" version >/dev/null
done

#!/usr/bin/env bash
# deploy/helm/test/kind-smoke.sh: installs the chart into a throwaway kind cluster and checks it
# : the bundled Postgres, the migrate Job, the api and worker becoming ready, `helm test`
# (/health, /ready with Postgres and S3, the web client), then an upgrade through the
# pre-upgrade migrate hook and `helm test` again. CI's `helm` job runs it; locally it needs
# Docker, kind and helm (deploy/helm/install-tools.sh <dir> helm kind).
#   IMAGE=openrows:local deploy/helm/test/kind-smoke.sh
# IMAGE must exist in the local Docker daemon (docker/Dockerfile's oss target). No kubectl: Helm
# does the work, and diagnostics run the node container's own kubectl.
set -euo pipefail

IMAGE="${IMAGE:?set IMAGE to the oss image in the local daemon, e.g. openrows:local}"
CLUSTER="${KIND_CLUSTER:-openrows-smoke-$$}"
HELM="${HELM:-helm}"
KIND="${KIND:-kind}"
NODE_IMAGE=kindest/node:v1.34.11@sha256:44e222ee2132dab25ff87301682f89eb82c7880ea3a1bf543bfe9708fd08d67d
NS=openrows
here="$(cd "$(dirname "$0")" && pwd)"
chart="$(cd "$here/../openrows" && pwd)"

work="$(mktemp -d)"
export KUBECONFIG="$work/kubeconfig"
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- diagnostics"
    k() { docker exec "$CLUSTER-control-plane" kubectl --kubeconfig /etc/kubernetes/admin.conf "$@" || true; }
    k get all,jobs,pvc -n "$NS" -o wide
    k get events -n "$NS" --sort-by=.lastTimestamp
    for pod in $(k get pods -n "$NS" -o name); do
      echo "--- $pod"
      k logs -n "$NS" "$pod" --all-containers --tail 80
    done
  fi
  if [ -z "${KEEP_CLUSTER:-}" ]; then "$KIND" delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true; fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

rand() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

"$KIND" create cluster --name "$CLUSTER" --image "$NODE_IMAGE" --wait 180s
"$KIND" load docker-image "$IMAGE" --name "$CLUSTER"

repo="${IMAGE%:*}"
tag="${IMAGE##*:}"

# The operator's part: the Secret (random, URL-safe values) and an S3 server.
access_key="$(rand)"
"$HELM" install fixtures "$here/kind/fixtures" -n "$NS" --create-namespace --wait --timeout 5m \
  --set-string "secrets.ENCRYPTION_KEY=$(head -c 32 /dev/urandom | base64)" \
  --set-string "secrets.OIDC_CLIENT_SECRET=$(rand)" \
  --set-string "secrets.S3_ACCESS_KEY=k${access_key:0:19}" \
  --set-string "secrets.S3_SECRET_KEY=$(rand)" \
  --set-string "secrets.POSTGRES_PASSWORD=$(rand)" \
  --set-string "secrets.OPENROWS_APP_DB_PASSWORD=$(rand)"

values=(
  --set "image.repository=$repo" --set "image.tag=$tag" --set image.pullPolicy=Never
  --set appUrl=https://openrows.smoke.test
  --set existingSecret=openrows-secrets
  # Discovery is lazy: nothing calls the issuer until someone signs in.
  --set oidc.issuerUrl=https://auth.smoke.test/realms/openrows
  --set "s3.endpoint=http://s3.$NS.svc.cluster.local:9000" --set s3.bucket=openrows
  --set postgresql.persistence.size=1Gi
)

"$HELM" install openrows "$chart" -n "$NS" "${values[@]}" --wait --wait-for-jobs --timeout 10m
"$HELM" test openrows -n "$NS" --logs --timeout 3m

# An upgrade runs the migrations as the pre-upgrade hook (a no-op now) before the new pods.
"$HELM" upgrade openrows "$chart" -n "$NS" "${values[@]}" --set api.replicas=2 --wait --timeout 10m
"$HELM" history openrows -n "$NS"
"$HELM" test openrows -n "$NS" --logs --timeout 3m
echo "kind smoke test passed"

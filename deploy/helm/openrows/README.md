# OpenRows Helm chart

The open-source OpenRows server (AGPL-3.0) on Kubernetes: the api, the worker, the migrate Job,
and optionally Postgres 16, Valkey and an Ingress. It runs the `oss` image
(`ghcr.io/draggable/openrows`, or your own build of `docker/Dockerfile`'s `oss` target), never
the hosted edition.

The guide is the "Kubernetes (Helm)" section of
[docs/guide/self-hosting.md](../../../docs/guide/self-hosting.md), published at
https://openrows.io/docs/self-hosting. In short:

```sh
kubectl create namespace openrows
kubectl -n openrows create secret generic openrows-secrets --from-literal=... # values.yaml lists the keys
helm install openrows ./deploy/helm/openrows -n openrows -f openrows-values.yaml --wait --timeout 10m
helm test openrows -n openrows
```

The chart refuses to render without `image.tag` (or `image.digest`), `appUrl`, `existingSecret`,
`oidc.issuerUrl`, `s3.endpoint` and `s3.bucket`, and never creates a Secret.

## Tests

- `deploy/helm/test/chart.test.ts` (in `npm test`, the `helm` project): `helm lint --strict`,
  `helm template` against the golden files in `test/golden/` for each file in `test/values/`,
  the schema's and templates' refusals, and the hardening of every pod. It needs the pinned
  Helm: `deploy/helm/install-tools.sh <dir> helm`, then `HELM=<dir>/helm npm test`. After a
  deliberate change to the templates, rewrite the golden files with
  `UPDATE_GOLDEN=1 HELM=<dir>/helm npx vitest run --project helm` and review the diff.
- `deploy/helm/test/kind-smoke.sh` (CI's `helm` job): a throwaway kind cluster, the chart with
  its bundled Postgres and an in-cluster S3, `helm test`, an upgrade through the pre-upgrade
  migrate hook and `helm test` again. Locally: Docker, `install-tools.sh <dir> helm kind`, then
  `PATH=<dir>:$PATH IMAGE=openrows:local deploy/helm/test/kind-smoke.sh`.

Bump `version` in `Chart.yaml` with every change to the chart.

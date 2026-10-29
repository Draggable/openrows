{{/* Names and labels. */}}
{{- define "openrows.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "openrows.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "openrows.selectorLabels" -}}
app.kubernetes.io/name: {{ include "openrows.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "openrows.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version | replace "+" "_" }}
{{ include "openrows.selectorLabels" . }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
app.kubernetes.io/part-of: openrows
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
{{- end -}}

{{- define "openrows.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "openrows.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "openrows.postgresqlHost" -}}
{{- printf "%s-postgresql" (include "openrows.fullname" .) -}}
{{- end -}}

{{- define "openrows.valkeyHost" -}}
{{- printf "%s-valkey" (include "openrows.fullname" .) -}}
{{- end -}}

{{/* The OSS image, by digest when one is set. Refuses to render without a tag or digest. */}}
{{- define "openrows.image" -}}
{{- $img := .Values.image -}}
{{- if $img.digest -}}
{{- printf "%s@%s" $img.repository $img.digest -}}
{{- else -}}
{{- printf "%s:%s" $img.repository (required "image.tag is required (e.g. sha-<commit>), or set image.digest" $img.tag) -}}
{{- end -}}
{{- end -}}

{{- define "openrows.secretName" -}}
{{- required "existingSecret is required: the name of a Secret you created with the keys values.yaml lists (the chart never creates one)" .Values.existingSecret -}}
{{- end -}}

{{/* One env entry from the Secret. dict: root, name (env var), key (default: name), optional. */}}
{{- define "openrows.secretRef" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ include "openrows.secretName" .root }}
      key: {{ default .name .key }}
      {{- if .optional }}
      optional: true
      {{- end }}
{{- end -}}

{{/*
The database variables, by component (api, worker, migrate). The bundled Postgres's URLs are
built from the Secret's passwords with Kubernetes' $(VAR) expansion, so those passwords must be
URL-safe (openssl rand -hex 24); an external database's URLs come whole from the Secret.
*/}}
{{- define "openrows.databaseEnv" -}}
{{- $root := .root -}}
{{- $c := .component -}}
{{- if $root.Values.postgresql.enabled -}}
{{- $pg := $root.Values.postgresql -}}
{{- $host := include "openrows.postgresqlHost" $root -}}
{{- if ne $c "api" }}
{{ include "openrows.secretRef" (dict "root" $root "name" "PG_PASSWORD" "key" "POSTGRES_PASSWORD") }}
{{- end }}
{{ include "openrows.secretRef" (dict "root" $root "name" "OPENROWS_APP_DB_PASSWORD") }}
{{- if eq $c "migrate" }}
- name: MIGRATION_DATABASE_URL
  value: {{ printf "postgresql://%s:$(PG_PASSWORD)@%s:5432/%s" $pg.username $host $pg.database | quote }}
{{- else }}
- name: DATABASE_URL
  value: {{ printf "postgresql://openrows_app:$(OPENROWS_APP_DB_PASSWORD)@%s:5432/%s" $host $pg.database | quote }}
{{- end }}
{{- if eq $c "worker" }}
- name: INDEX_DATABASE_URL
  value: {{ printf "postgresql://%s:$(PG_PASSWORD)@%s:5432/%s" $pg.username $host $pg.database | quote }}
{{- end }}
{{- else -}}
{{- if eq $c "migrate" }}
{{ include "openrows.secretRef" (dict "root" $root "name" "MIGRATION_DATABASE_URL") }}
{{ include "openrows.secretRef" (dict "root" $root "name" "OPENROWS_APP_DB_PASSWORD" "optional" true) }}
{{- else }}
{{ include "openrows.secretRef" (dict "root" $root "name" "DATABASE_URL") }}
{{- end }}
{{- if eq $c "worker" }}
{{ include "openrows.secretRef" (dict "root" $root "name" "INDEX_DATABASE_URL" "optional" true) }}
{{- end }}
{{- end -}}
{{- end -}}

{{/* The secrets the api (component api) or the worker (component worker) reads. */}}
{{- define "openrows.secretEnv" -}}
{{- $root := .root -}}
{{- $v := $root.Values -}}
{{- $c := .component -}}
{{ include "openrows.databaseEnv" . | trim }}
{{ include "openrows.secretRef" (dict "root" $root "name" "ENCRYPTION_KEY") }}
{{ include "openrows.secretRef" (dict "root" $root "name" "S3_ACCESS_KEY") }}
{{ include "openrows.secretRef" (dict "root" $root "name" "S3_SECRET_KEY") }}
{{- if eq $c "api" }}
{{ include "openrows.secretRef" (dict "root" $root "name" "OIDC_CLIENT_SECRET") }}
{{- if $v.valkey.enabled }}
{{ include "openrows.secretRef" (dict "root" $root "name" "VALKEY_PASSWORD") }}
- name: REDIS_URL
  value: {{ printf "redis://:$(VALKEY_PASSWORD)@%s:6379" (include "openrows.valkeyHost" $root) | quote }}
{{- else }}
{{ include "openrows.secretRef" (dict "root" $root "name" "REDIS_URL" "optional" true) }}
{{- end }}
{{- if $v.turnstile.siteKey }}
- name: TURNSTILE_SITE_KEY
  value: {{ $v.turnstile.siteKey | quote }}
{{ include "openrows.secretRef" (dict "root" $root "name" "TURNSTILE_SECRET_KEY") }}
{{- end }}
{{- end }}
{{- if and (eq $c "worker") $v.oidc.adminClientId }}
- name: OIDC_ADMIN_CLIENT_ID
  value: {{ $v.oidc.adminClientId | quote }}
{{ include "openrows.secretRef" (dict "root" $root "name" "OIDC_ADMIN_CLIENT_SECRET") }}
{{- end }}
{{- if $v.smtp.user }}
{{ include "openrows.secretRef" (dict "root" $root "name" "SMTP_PASSWORD") }}
{{- end }}
{{- if $v.ai.model }}
{{ include "openrows.secretRef" (dict "root" $root "name" "AI_API_KEY" "optional" true) }}
{{- end }}
{{- end -}}

{{/*
The api's and worker's first container: waits until the migrate Job has run (on install the Job
starts with them; on upgrade the pre-upgrade hook has already run, so it passes at once). Done
means openrows_app can log in, which the Job's last step allows, and the job queue's schema,
which it installs after the migrations, is granted to it.
*/}}
{{- define "openrows.waitForMigrations" -}}
- name: wait-for-migrations
  image: {{ include "openrows.image" .root }}
  imagePullPolicy: {{ .root.Values.image.pullPolicy }}
  command:
    - node
    - -e
    - |
      const pg = require('pg');
      const sql = "SELECT CASE WHEN to_regnamespace('pgboss') IS NULL THEN false ELSE has_schema_privilege('pgboss', 'USAGE') END AS ok";
      (async () => {
        for (;;) {
          const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
          try {
            await client.connect();
            const { rows } = await client.query(sql);
            if (rows[0].ok) process.exit(0);
          } catch {
            // Not migrated yet: openrows_app can't log in before the Job's last step.
          } finally {
            await client.end().catch(() => {});
          }
          console.log('Waiting for the migrate Job');
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      })();
  env:
    {{- include "openrows.databaseEnv" (dict "root" .root "component" "api") | trim | nindent 4 }}
  securityContext:
    {{- toYaml .root.Values.securityContext | nindent 4 }}
  resources:
    requests:
      cpu: 10m
      memory: 64Mi
    limits:
      memory: 128Mi
{{- end -}}

{{/* Fails the render when a required value is missing or the existing Secret lacks a key. */}}
{{- define "openrows.validate" -}}
{{- $v := .Values -}}
{{- $_ := include "openrows.image" . -}}
{{- $secret := include "openrows.secretName" . -}}
{{- $_ := required "appUrl is required: the public https origin, e.g. https://openrows.example.org" $v.appUrl -}}
{{- $_ := required "oidc.issuerUrl is required (https)" $v.oidc.issuerUrl -}}
{{- $_ := required "s3.endpoint is required" $v.s3.endpoint -}}
{{- $_ := required "s3.bucket is required" $v.s3.bucket -}}
{{- if and $v.ingress.enabled (not $v.ingress.host) (not (regexMatch "^https://[^/:]+(:[0-9]+)?/?$" $v.appUrl)) -}}
{{- fail "ingress.host is required when appUrl has a path" -}}
{{- end -}}
{{- range $name, $_ := $v.extraEnv -}}
{{- if or (has $name (list "NODE_ENV" "EDITION" "DATABASE_URL" "MIGRATION_DATABASE_URL" "INDEX_DATABASE_URL" "REDIS_URL" "PORT" "WORKER_PORT" "METRICS_PORT")) (regexMatch "(SECRET|PASSWORD|TOKEN|_KEY)" $name) -}}
{{- fail (printf "extraEnv.%s: set it through the chart's own values or the Secret, not extraEnv" $name) -}}
{{- end -}}
{{- end -}}
{{- $keys := list "ENCRYPTION_KEY" "OIDC_CLIENT_SECRET" "S3_ACCESS_KEY" "S3_SECRET_KEY" -}}
{{- if $v.postgresql.enabled -}}
{{- $keys = concat $keys (list "POSTGRES_PASSWORD" "OPENROWS_APP_DB_PASSWORD") -}}
{{- else -}}
{{- $keys = concat $keys (list "DATABASE_URL" "MIGRATION_DATABASE_URL") -}}
{{- end -}}
{{- if $v.valkey.enabled -}}{{- $keys = append $keys "VALKEY_PASSWORD" -}}{{- end -}}
{{- if $v.smtp.user -}}{{- $keys = append $keys "SMTP_PASSWORD" -}}{{- end -}}
{{- if $v.oidc.adminClientId -}}{{- $keys = append $keys "OIDC_ADMIN_CLIENT_SECRET" -}}{{- end -}}
{{- if $v.turnstile.siteKey -}}{{- $keys = append $keys "TURNSTILE_SECRET_KEY" -}}{{- end -}}
{{- /* Only against a cluster (install, upgrade, --dry-run=server): `helm template` sees none. */ -}}
{{- $found := lookup "v1" "Secret" .Release.Namespace $secret -}}
{{- if $found -}}
{{- $data := default dict $found.data -}}
{{- $missing := list -}}
{{- range $keys -}}{{- if not (hasKey $data .) -}}{{- $missing = append $missing . -}}{{- end -}}{{- end -}}
{{- if $missing -}}
{{- fail (printf "Secret %s lacks the keys %s (values.yaml, existingSecret)" $secret (join ", " $missing)) -}}
{{- end -}}
{{- end -}}
{{- end -}}

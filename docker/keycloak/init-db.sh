#!/bin/sh
# Keycloak's database in the stack's Postgres: role `keycloak` with its own password
# (KC_DB_PASSWORD, distinct from PG_PASSWORD) owning database `keycloak`. Runs as the one-shot
# `keycloak-db` service (selfhost.yml's `keycloak` profile) on EVERY `up`, so it also works on a
# volume created before Keycloak existed (an initdb.d script only runs on an empty volume) and
# re-applies the password after a rotation. Idempotent. The password goes to psql as a `-v`
# variable and is quoted with %L, so it can't inject SQL, and it is never printed. PUBLIC loses CONNECT on
# keycloak, so openrows_app can't open it. The app database keeps PUBLIC's CONNECT (openrows_app
# needs it, and migrate may create that role after this runs); the keycloak role has no privilege
# on any of its tables.
set -eu
if [ "$KC_DB_PASSWORD" = "${PGPASSWORD-}" ]; then
  echo "keycloak-db: KC_DB_PASSWORD must differ from PG_PASSWORD; nothing was changed" >&2
  exit 64
fi
psql -v ON_ERROR_STOP=1 -v kc_password="$KC_DB_PASSWORD" <<'SQL'
SELECT 'CREATE ROLE keycloak LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'keycloak') \gexec
SELECT format('ALTER ROLE keycloak LOGIN PASSWORD %L', :'kc_password') \gexec
SELECT 'CREATE DATABASE keycloak OWNER keycloak' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'keycloak') \gexec
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
SQL
echo "keycloak database ready"

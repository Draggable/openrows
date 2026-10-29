#!/usr/bin/env bash
# Adds (or updates) a social sign-in provider in the running OpenRows Keycloak, in one command.
#
#   scripts/keycloak-add-idp.sh <alias> <env-file>
#
#   alias     google | github (Keycloak's built-in social providers; the alias is the providerId)
#   env-file  holds the provider's OAuth client: CLIENT_ID= and CLIENT_SECRET=, or the prefixed
#             form <ALIAS>_CLIENT_ID= / <ALIAS>_CLIENT_SECRET= (e.g. GOOGLE_CLIENT_ID=). Keep it mode 600.
#
# Environment (all optional):
#   KC_CONTAINER   the Keycloak container      (default: openrows-prod-keycloak-1)
#   KC_REALM       the realm                   (default: openrows)
#   KC_KCADM_FILE  the master realm's kcadm service account, client= and secret= lines, written by
#                  docker/keycloak/harden-admin.sh (default: keycloak-kcadm.env next to the env
#                  file); used when it exists
#   KC_ADMIN_FILE  otherwise: user= and password= of a master admin without OTP or pending
#                  required actions (default: keycloak-admin.txt next to the env file)
#   KC_PUBLIC_URL  Keycloak's public URL, only used to print the redirect URI
#                  (default: https://auth.openrows.io)
#   IDP_ENABLED    false to add the provider switched off (default: true)
#
# Run it on the Docker host, next to the env file. It is idempotent: an existing provider
# with the same alias is updated in place (e.g. to rotate the secret). Secrets never appear on a
# command line: the admin secret travels in the container's environment and the provider JSON
# on stdin. The app shows the button once the alias is in AUTH_PROVIDERS (docs/deploy/keycloak.md).
set -euo pipefail

usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
[ $# -eq 2 ] || usage
alias="$1"
env_file="$2"
case "$alias" in
  google | github) ;;
  *) echo "unsupported alias '$alias' (google or github)" >&2; exit 2 ;;
esac
[ -r "$env_file" ] || { echo "cannot read $env_file" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

container="${KC_CONTAINER:-openrows-prod-keycloak-1}"
realm="${KC_REALM:-openrows}"
admin_file="${KC_ADMIN_FILE:-$(dirname "$env_file")/keycloak-admin.txt}"
kcadm_file="${KC_KCADM_FILE:-$(dirname "$env_file")/keycloak-kcadm.env}"
public_url="${KC_PUBLIC_URL:-https://auth.openrows.io}"
enabled="${IDP_ENABLED:-true}"

# Reads KEY=value from a file without sourcing it (values may contain shell characters).
read_key() { sed -n "s/^[[:space:]]*\(export[[:space:]]\+\)\{0,1\}$1=//p" "$2" | tail -n1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"; }
upper=$(printf '%s' "$alias" | tr '[:lower:]' '[:upper:]')
client_id=$(read_key "${upper}_CLIENT_ID" "$env_file"); [ -n "$client_id" ] || client_id=$(read_key CLIENT_ID "$env_file")
client_secret=$(read_key "${upper}_CLIENT_SECRET" "$env_file"); [ -n "$client_secret" ] || client_secret=$(read_key CLIENT_SECRET "$env_file")
[ -n "$client_id" ] && [ -n "$client_secret" ] || { echo "$env_file needs CLIENT_ID and CLIENT_SECRET" >&2; exit 1; }

# kcadm reads KC_CLI_CLIENT_SECRET / KC_CLI_PASSWORD itself. OTP on the master admin blocks
# password logins, so the service account comes first.
if [ -r "$kcadm_file" ]; then
  KC_LOGIN="--client $(read_key client "$kcadm_file")"
  KC_CLI_CLIENT_SECRET=$(read_key secret "$kcadm_file")
  export KC_CLI_CLIENT_SECRET
else
  [ -r "$admin_file" ] || { echo "cannot read admin credentials $kcadm_file or $admin_file (set KC_KCADM_FILE)" >&2; exit 1; }
  KC_LOGIN="--user $(read_key user "$admin_file")"
  KC_CLI_PASSWORD=$(read_key password "$admin_file")
  export KC_CLI_PASSWORD
fi
export KC_LOGIN

case "$alias" in
  google) display="Google"; order=1; extra='{}' ;;
  github) display="GitHub"; order=2; extra='{"defaultScope":"user:email"}' ;;
esac

# The same shape as identityProviders in docker/keycloak/openrows-realm*.json.
payload=$(jq -n --arg alias "$alias" --arg display "$display" --arg id "$client_id" \
  --arg secret "$client_secret" --arg order "$order" --argjson enabled "$enabled" --argjson extra "$extra" '{
    alias: $alias, displayName: $display, providerId: $alias, enabled: $enabled,
    trustEmail: true, storeToken: false, linkOnly: false,
    firstBrokerLoginFlowAlias: "first broker login",
    config: ({clientId: $id, clientSecret: $secret, syncMode: "IMPORT", guiOrder: $order} + $extra)
  }')

# kcadm runs inside the container against Keycloak's local HTTP listener.
printf '%s' "$payload" | docker exec -i -e KC_LOGIN -e KC_CLI_CLIENT_SECRET -e KC_CLI_PASSWORD -e REALM="$realm" -e ALIAS="$alias" \
  "$container" bash -c '
    set -euo pipefail
    kc=/opt/keycloak/bin/kcadm.sh
    export HOME=/tmp
    $kc config credentials --config /tmp/kcadm-idp.config --server http://localhost:8080 --realm master \
      $KC_LOGIN >/dev/null 2>&1 \
      || { echo "admin login failed (OTP or a pending required action blocks password logins: run docker/keycloak/harden-admin.sh for the service account)" >&2; exit 1; }
    payload=$(cat)
    if $kc get "identity-provider/instances/$ALIAS" -r "$REALM" --config /tmp/kcadm-idp.config >/dev/null 2>&1; then
      printf "%s" "$payload" | $kc update "identity-provider/instances/$ALIAS" -r "$REALM" --config /tmp/kcadm-idp.config -f -
      echo "updated identity provider $ALIAS in realm $REALM"
    else
      printf "%s" "$payload" | $kc create identity-provider/instances -r "$REALM" --config /tmp/kcadm-idp.config -f -
      echo "created identity provider $ALIAS in realm $REALM"
    fi
    rm -f /tmp/kcadm-idp.config
  '

echo "redirect URI to register at the provider: $public_url/realms/$realm/broker/$alias/endpoint"

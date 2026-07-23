#!/usr/bin/env bash

set -euo pipefail

read -r -s -p "Enter quietpact-arc-testnet keystore password: " QUIETPACT_KEYSTORE_PASSWORD
printf "\n"
QUIETPACT_PASSWORD_FILE="$(mktemp /tmp/quietpact-keystore-password.XXXXXX)"
chmod 600 "$QUIETPACT_PASSWORD_FILE"
printf "%s" "$QUIETPACT_KEYSTORE_PASSWORD" >"$QUIETPACT_PASSWORD_FILE"
export QUIETPACT_PASSWORD_FILE
unset QUIETPACT_KEYSTORE_PASSWORD

cleanup() {
  rm -f "$QUIETPACT_PASSWORD_FILE"
  unset QUIETPACT_PASSWORD_FILE
}
trap cleanup EXIT

node scripts/smoke-arc-testnet.mjs

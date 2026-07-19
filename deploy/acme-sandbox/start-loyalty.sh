#!/bin/sh
set -eu

: "${LIP_API_KEY:?LIP_API_KEY is required}"
: "${LOYALTY_WEBHOOK_SECRET:?LOYALTY_WEBHOOK_SECRET is required}"

if [ -n "${ACME_BFF_HOST:-}" ]; then
  export LIP_WEBHOOK_URL="http://${ACME_BFF_HOST}:${ACME_BFF_PORT:-10000}/loyalty/webhook"
fi
export LIP_WEBHOOK_SECRET="${LOYALTY_WEBHOOK_SECRET}"

exec node packages/cli/dist/cli.js serve \
  --host "${HOST:-0.0.0.0}" \
  --port "${PORT:-3210}" \
  --api-key "${LIP_API_KEY}" \
  --database "${LIP_DATABASE_PATH:-/data/reference.db}" \
  --program /config/acme-program.json \
  --no-seed

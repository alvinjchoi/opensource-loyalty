#!/bin/sh
set -eu

: "${LIP_API_KEY:?LIP_API_KEY is required}"
: "${LOYALTY_WEBHOOK_SECRET:?LOYALTY_WEBHOOK_SECRET is required}"

if [ -n "${SAKURA_BFF_HOST:-}" ]; then
  export LIP_WEBHOOK_URL="http://${SAKURA_BFF_HOST}:${SAKURA_BFF_PORT:-10000}/loyalty/webhook"
fi
export LIP_WEBHOOK_SECRET="${LOYALTY_WEBHOOK_SECRET}"

exec node packages/cli/dist/cli.js serve \
  --host "${HOST:-0.0.0.0}" \
  --port "${PORT:-3210}" \
  --api-key "${LIP_API_KEY}" \
  --database "${LIP_DATABASE_PATH:-/data/reference.db}" \
  --program /config/sakura-program.json \
  --no-seed

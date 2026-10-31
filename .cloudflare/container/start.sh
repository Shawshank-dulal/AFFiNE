#!/bin/sh
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required (use the direct, non-pooled Neon connection string)." >&2
  exit 1
fi

# The container disk is ephemeral. Without a fixed key every restart would
# generate a new one and invalidate sessions and encrypted settings.
if [ -z "${AFFINE_PRIVATE_KEY:-}" ]; then
  echo "AFFINE_PRIVATE_KEY is required. See .cloudflare/README.md." >&2
  exit 1
fi

if [ -z "${REDIS_SERVER_URL:-}" ] && [ -z "${REDIS_SERVER_HOST:-}" ]; then
  redis-server --daemonize yes --bind 127.0.0.1 --port 6379 \
    --save '' --appendonly no --maxmemory-policy noeviction
  export REDIS_SERVER_HOST=127.0.0.1
  export REDIS_SERVER_PORT=6379
fi

# AFFiNE only sends mail over SMTP. With a Mail Mario key, a local bridge
# accepts SMTP and relays each message to the Mail Mario HTTP API.
if [ -n "${MAILMARIO_API_KEY:-}" ]; then
  export SMTP_BRIDGE_PORT="${SMTP_BRIDGE_PORT:-2525}"
  node /usr/local/lib/affine/smtp-bridge/index.mjs &
  export MAILER_HOST=127.0.0.1
  export MAILER_PORT="$SMTP_BRIDGE_PORT"
  export MAILER_USER=affine
  export MAILER_PASSWORD=bridge
  export MAILER_IGNORE_TLS=true
fi

node /usr/local/lib/affine/gen-config.mjs

# Runs the Prisma and data migrations. Safe to run on every boot.
node ./scripts/self-host-predeploy.js

exec node ./dist/main.js

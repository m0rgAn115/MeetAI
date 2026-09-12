#!/bin/sh
set -eu

echo "Waiting for PostgreSQL..."
until pg_isready -d "$DATABASE_URL" >/dev/null 2>&1; do
  sleep 1
done

echo "Applying memory schema..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_contextual_memory.sql

if [ "${ALLOW_LOCAL_IDENTITY:-false}" = "true" ]; then
  echo "Bootstrapping local workspace identity..."
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -v workspace_id="${LOCAL_WORKSPACE_ID}" \
    -v user_id="${LOCAL_USER_ID}" \
    -v user_email="${LOCAL_USER_EMAIL:-local@example.com}" \
    -f docker/bootstrap-local.sql
fi
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/002_memory_observer.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/003_google_oauth_tokens.sql

if [ "${SEED_DEMO_DATA:-true}" = "true" ]; then
  echo "Loading idempotent demo data..."
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f demo/seed.sql
fi

exec npm run start

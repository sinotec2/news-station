#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ -f .env ]; then
  exec node --env-file=.env scripts/cron-edition.mjs "$@"
fi
exec node scripts/cron-edition.mjs "$@"

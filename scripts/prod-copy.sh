#!/bin/sh
# Replaces the dev DB (app/data/app.db) with a copy of the prod DB, keeping the old dev DB.
# The dev server holds the file open: stop it first, or the copy can tear.
set -eu
PROD="$HOME/Library/Application Support/learn-polish/app.db"
cd "$(dirname "$0")/../app/data"
if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Stop the dev server on :3000 first." >&2
  exit 1
fi
[ -f app.db ] && sqlite3 app.db ".backup app.db.before-prod-copy-$(date +%F-%H%M)"
rm -f app.db app.db-wal app.db-shm
sqlite3 "$PROD" ".backup app.db"
sqlite3 app.db "pragma integrity_check;"

#!/bin/bash
# Deploys origin/main to the laptop prod. See docs/operations.md.
# Runs from $ROOT/repo after the launchd job resets it to origin/main, so a broken
# version of this script is fixed by pushing the fix.
set -euo pipefail

ROOT="${LP_ROOT:-$HOME/apps/learn-polish}"
DATA="${LP_DATA:-$HOME/Library/Application Support/learn-polish}"
SERVICE="${LP_SERVICE:-gui/$(id -u)/com.niktekusho.learn-polish}"
FAILED="$DATA/deploy-failed.json"

cd "$ROOT/repo"
new=$(git rev-parse origin/main)
cur=$(basename "$(readlink "$ROOT/current" || true)")

[[ "$new" == "$cur" ]] && exit 0
# A failed SHA is not retried: the next push is the retry.
[[ -f "$FAILED" && "$(jq -r .sha "$FAILED")" == "$new" ]] && exit 0

echo "$(date '+%F %T') deploying $new (was ${cur:-none})"
rel="$ROOT/releases/$new"
log="$ROOT/releases/$new.log"
git worktree remove --force "$rel" 2>/dev/null || true
git worktree add -q --detach "$rel" "$new"

# && chain, not set -e: errexit is ignored inside an `if` condition.
if ! (
  cd "$rel" &&
    pnpm install --frozen-lockfile &&
    VITE_GIT_SHA="$new" pnpm --filter app build &&
    cd sidecar && uv sync --frozen
) >"$log" 2>&1; then
  jq -n --arg sha "$new" --arg log "$(tail -n 40 "$log")" '{sha: $sha, log: $log}' >"$FAILED"
  echo "build failed, see $log"
  exit 1
fi

# Migrations run on server start and are forward-only: keep the pre-migration DB.
if [[ -n "$cur" ]] && ! git diff --quiet "$cur" "$new" -- app/drizzle; then
  mkdir -p "$DATA/backups"
  sqlite3 "$DATA/app.db" ".backup '$DATA/backups/app-before-$new.db'"
  ls -t "$DATA/backups"/app-before-*.db | tail -n +4 | xargs rm -f
fi

ln -sfn "$rel" "$ROOT/current"
rm -f "$FAILED"
launchctl kickstart -k "$SERVICE"
echo "$(date '+%F %T') live: $new"

# Keep the 3 newest releases; never the live one.
for old in $(ls -t "$ROOT/releases" | grep -v '\.log$' | tail -n +4); do
  [[ "$old" == "$new" ]] && continue
  git worktree remove --force "$ROOT/releases/$old"
  rm -f "$ROOT/releases/$old.log"
done

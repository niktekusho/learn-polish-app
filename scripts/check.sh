#!/bin/sh
# Every check the pre-commit hook runs on staged files, run on the whole tree:
# keep it in step with `staged` in vite.config.ts. The sidecar's pytest is left out.
set -e
cd "$(dirname "$0")/.."

all=$(git ls-files)
src=$(git ls-files 'app/src/*.ts' 'app/src/*.tsx')

vp fmt --check
printf '%s\n' "$all" | xargs sh scripts/check-dashes.sh
vp lint
printf '%s\n' "$src" | xargs sh scripts/check-plural.sh
printf '%s\n' "$src" | xargs sh scripts/check-spacing.sh
printf '%s\n' "$src" | xargs sh scripts/check-type-scale.sh
pnpm --filter app typecheck
pnpm --filter app test

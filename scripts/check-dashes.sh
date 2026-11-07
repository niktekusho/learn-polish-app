#!/bin/sh
# The owner's writing rules ban em dashes in prose, comments and UI copy alike.
# Lockfiles and generated files are skipped: no one writes them by hand.
FILES=$(printf '%s\n' "$@" | grep -vE '(pnpm-lock\.yaml|uv\.lock|routeTree\.gen\.ts|drizzle/meta/)')
DASH=$(printf '\342\200\224')
[ -z "$FILES" ] && exit 0
if printf '%s\n' "$FILES" | tr '\n' '\0' | xargs -0 grep -HnIF "$DASH"; then
  echo "Rewrite the lines above without em dashes: end the sentence or use a comma." >&2
  exit 1
fi

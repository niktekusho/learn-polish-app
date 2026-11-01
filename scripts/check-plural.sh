#!/bin/sh
# Counted Italian words go through plural() in app/src/plural.ts.
if grep -nE '=== 1 \? "' "$@"; then
  echo "Use plural(n, one, many) from #/plural for the lines above." >&2
  exit 1
fi

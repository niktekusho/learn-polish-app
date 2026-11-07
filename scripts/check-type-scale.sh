#!/bin/sh
# A font size equal to a type-scale token uses the token (docs/ui-redesign.md, Type scale):
# text-[15px] is text-base. The token sizes are read from the @theme in app/src/styles.css.
sizes=$(sed -nE 's/^ *--text-[a-z0-9]+: ([0-9.]+)px;.*/\1/p' app/src/styles.css | sed 's/\./\\./g' | paste -sd'|' -)
PAT="text-\[($sizes)px\]"
if grep -nE "$PAT" "$@"; then
  echo "Use the type-scale token (text-sm, text-base, text-md, ...) for the size above." >&2
  exit 1
fi

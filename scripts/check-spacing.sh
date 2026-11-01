#!/bin/sh
# Spacing sits on the 4px scale (docs/ui-redesign.md, Spacing): Tailwind half steps from 1.5 up
# are off it. py-1.5 (the 56px top bar) and 0.5 (2px hairlines) are the allowed exceptions.
PAT='(^|[ "`:])-?(p|m|gap|space|inset|top|bottom|left|right)[trblxy]?-[1-9][0-9]*\.5([^0-9]|$)'
if grep -nE "$PAT" "$@" | sed -E 's/(^|[ "`:])py-1\.5([^0-9]|$)/\1\2/g' | grep -E "$PAT"; then
  echo "Move the spacing above onto the 4px scale (whole Tailwind steps)." >&2
  exit 1
fi

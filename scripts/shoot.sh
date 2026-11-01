#!/bin/sh
# Screenshot a page of the running dev server: scripts/shoot.sh <path> <out.png> [W,H]
# Frames from docs/ui-redesign.md: 412,860 (portrait), 915,360 (landscape), 1280,860 (desktop).
# Reduced motion shows reveal animations in their end state; the alarm caps a hang on Vite's HMR socket.
set -eu
CHROME="${CHROME:-$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell | tail -n 1)}"
perl -e 'alarm 25; exec @ARGV' "$CHROME" --headless --hide-scrollbars --force-prefers-reduced-motion \
  --run-all-compositor-stages-before-draw --window-size="${3:-412,860}" --screenshot="$2" \
  "${BASE_URL:-http://127.0.0.1:3000}$1" >/dev/null 2>&1
echo "$2"

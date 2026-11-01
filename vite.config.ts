import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp fmt --no-error-on-unmatched-pattern",
    "app/src/**/*.{ts,tsx}": [
      "vp lint",
      "sh scripts/check-plural.sh",
      "sh scripts/check-spacing.sh",
    ],
  },
  fmt: {
    ignorePatterns: [
      "pnpm-lock.yaml",
      "**/routeTree.gen.ts",
      "app/drizzle",
      "app/data",
      "app/public",
      "*.jsonl",
      "sidecar",
      "docs",
      "assets",
    ],
  },
});

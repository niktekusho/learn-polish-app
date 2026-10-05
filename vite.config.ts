import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp fmt --no-error-on-unmatched-pattern",
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

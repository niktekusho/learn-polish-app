import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": ["vp fmt --no-error-on-unmatched-pattern", "sh scripts/check-dashes.sh"],
    "app/src/**/*.{ts,tsx}": [
      "vp lint",
      "sh scripts/check-plural.sh",
      "sh scripts/check-spacing.sh",
      // tsc reads the whole project from tsconfig: a file list would make it skip tsconfig.
      () => "pnpm --filter app typecheck",
      (files) => `pnpm --filter app exec vitest related --run ${files.join(" ")}`,
    ],
    "sidecar/**/*.py": () => "uv run --directory sidecar pytest -q",
  },
  lint: {
    rules: {
      "no-unused-vars": ["error", { ignoreRestSiblings: true }],
      "no-unused-labels": "error",
      "no-unused-private-class-members": "error",
    },
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

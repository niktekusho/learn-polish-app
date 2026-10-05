# Laptop prod deploys itself from origin/main

Prod runs on the laptop because the gloss provider calls the local `claude` CLI with the
owner's credentials. It used to run from the dev checkout, so prod was whatever the working
tree held at the last manual `pnpm deploy`. Dev and prod shared `app/data/app.db`, so dev
migrations ran against real review data. The sidecar ran from source, so a restart picked up
whatever branch happened to be checked out.

Prod is now `origin/main`, nothing else. A launchd job polls GitHub every 2 minutes and, on a
new commit, builds it in `~/apps/learn-polish/releases/<sha>` (a worktree of a dedicated
clone). Only after a successful build does it repoint `current` and restart the app. The DB
lives outside every checkout in `~/Library/Application Support/learn-polish/`, and dev keeps
its own `app/data/app.db`. Runbook: `docs/operations.md`.

## Considered options

- **Deploy on local commit, or a `pnpm release` wrapper around `git push`:** rejected. A
  push from another device, or a plain `git push`, would leave prod stale. Polling GitHub
  catches every push and is the same model a remote host would use.
- **GitHub Actions self-hosted runner:** rejected. It needs a runner daemon, a token and
  workflow YAML just to get instant deploys instead of a 2-minute delay.
- **In-place build:** rejected. `vite build` empties `dist/` while prod serves from it, and a
  failed build leaves prod broken.
- **Tests as a deploy gate:** rejected for now. A successful build is the only gate.

## Consequences

- Migrations are forward-only, so a release that changes `app/drizzle` takes a DB snapshot
  first (last 3 kept). Code rollback after a migration also needs a DB restore.
- A failed build is recorded in `deploy-failed.json` and is not retried. The app shows a
  banner with the log tail until a later push builds.
- Each build embeds its commit (`VITE_GIT_SHA`). The app compares it with the server's on
  focus and offers a reload, so an open phone tab doesn't silently run old code.
- `deploy.sh` runs from the clone after it is reset to `origin/main`, so a broken deploy
  script is fixed by pushing the fix. launchd plist changes are not deployed: they are
  copied to `~/Library/LaunchAgents` by hand.
- Moving to another host means the same loop pointed at a different machine: clone, poll,
  build, swap. The `claude` CLI dependency is what keeps it on the laptop.

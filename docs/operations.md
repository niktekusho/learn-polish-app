# Operations

Prod runs on the laptop and is whatever is on `origin/main`. Pushing to `main` is the
release: a launchd job polls GitHub every 2 minutes, builds the new commit next to the live
one, and swaps to it only if the build succeeds. Decisions and reasons: ADR-0006.

## Where things are

| What                       | Path                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| **Prod database**          | `~/Library/Application Support/learn-polish/app.db`               |
| Pre-migration DB snapshots | `~/Library/Application Support/learn-polish/backups/` (last 3)    |
| Failed-deploy marker       | `~/Library/Application Support/learn-polish/deploy-failed.json`   |
| Prod git clone             | `~/apps/learn-polish/repo` (never edit; reset on every poll)      |
| Builds, one per commit     | `~/apps/learn-polish/releases/<sha>` + `<sha>.log` (last 3)       |
| Live build                 | `~/apps/learn-polish/current` → symlink to a release              |
| App + sidecar log          | `~/Library/Logs/learn-polish.log`                                 |
| Deploy log                 | `~/Library/Logs/learn-polish-deploy.log`                          |
| launchd jobs               | `~/Library/LaunchAgents/com.niktekusho.learn-polish{,-deploy}.plist` (sources in `ops/`) |
| Dev database               | `app/data/app.db` in whichever checkout runs `pnpm dev`           |

URLs (tailnet only):

- Prod: <https://macbook-pro.tail1ced86.ts.net> → `:10000` (sidecar on `:10001`)
- Test env: <https://macbook-pro.tail1ced86.ts.net:8443> → `pnpm dev` on `:3000`

## Is my phone on the latest version?

The footer shows the commit the page was built from. Coming back to the app checks the
server: a blue **New version available** bar means the server moved on, so tap it. A red
**Deploy of … failed** box means the newest `main` did not build; prod keeps serving the
previous commit, and the box holds the end of the build log. Push a fix: a failed commit is
never retried. To retry it anyway (say, a network blip during `pnpm install`), delete
`deploy-failed.json`.

## Everyday

- **Release:** merge to `main`, `git push`. Live within ~2 minutes.
- **Deploy now** instead of waiting: `launchctl kickstart gui/$UID/com.niktekusho.learn-polish-deploy`
- **Try a branch on the phone:** `pnpm dev` in that checkout, open the test-env URL. It uses
  that checkout's `app/data/app.db`, never the prod DB.
- **Refresh the dev DB with real data:**
  `sqlite3 ~/Library/Application\ Support/learn-polish/app.db ".backup app/data/app.db"`
  (stop `pnpm dev` first).

## Rollback

Prefer a forward fix: `git revert <sha> && git push`. The poller deploys the revert like any
other commit.

If the revert undoes a migration, the DB is already migrated: restore the snapshot too.

1. `launchctl bootout gui/$UID/com.niktekusho.learn-polish-deploy` (stop the poller,
   otherwise it redeploys `origin/main` within 2 minutes).
2. `launchctl bootout gui/$UID/com.niktekusho.learn-polish` (stop the app).
3. `ln -sfn ~/apps/learn-polish/releases/<good-sha> ~/apps/learn-polish/current`
4. To undo a migration:
   `cp ~/Library/Application\ Support/learn-polish/backups/app-before-<bad-sha>.db ~/Library/Application\ Support/learn-polish/app.db`
   and delete `app.db-wal` / `app.db-shm` next to it. Reviews made since the snapshot are lost.
5. `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.niktekusho.learn-polish.plist`
6. Push the revert to `main`, then bootstrap the deploy job again (same command as step 5,
   with `-deploy`).

## First-time install

Prereqs: the `ops/` changes are pushed to `origin/main`; Node, pnpm, uv, jq and sqlite3 at
the paths in the plists' `PATH`.

```sh
# 1. Stop the old prod (it ran from the dev checkout).
launchctl bootout gui/$UID/com.niktekusho.learn-polish

# 2. Move the DB out of the checkout. .backup copies WAL contents safely.
mkdir -p ~/Library/Application\ Support/learn-polish ~/apps/learn-polish/releases
sqlite3 ~/projects/github/learn-polish-app/app/data/app.db \
  ".backup '$HOME/Library/Application Support/learn-polish/app.db'"

# 3. Prod clone.
git clone https://github.com/niktekusho/learn-polish-app.git ~/apps/learn-polish/repo

# 4. Install both jobs. The app job retries until the first deploy creates `current`.
cp ~/apps/learn-polish/repo/ops/*.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.niktekusho.learn-polish.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.niktekusho.learn-polish-deploy.plist

# 5. Test env on :8443 (persists across reboots).
tailscale serve --bg --https=8443 http://127.0.0.1:3000
```

Check: `tail ~/Library/Logs/learn-polish-deploy.log` ends with `live: <sha>`, and the phone
footer shows the same SHA as `git rev-parse --short origin/main`.

After editing a plist in `ops/`, copy it to `~/Library/LaunchAgents/` and run `bootout` +
`bootstrap` for that job: launchd does not pick up plist changes on its own.

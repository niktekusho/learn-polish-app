// One-off: delete gloss rows produced by the dev StubGlossProvider. getGloss
// reads the cache provider-blind, so leftover stub rows would shadow real
// glosses once a real provider is active. Plain better-sqlite3 (no drizzle /
// path aliases) so it runs under bare `node` with no TS toolchain.
import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'

// Same anchor as src/db/index.ts: app/data/app.db (DATABASE_PATH overrides).
const dbPath =
  process.env.DATABASE_PATH ??
  fileURLToPath(new URL('../data/app.db', import.meta.url))

const db = new Database(dbPath)
const { changes } = db.prepare("DELETE FROM gloss WHERE provider = 'stub'").run()
console.log(`Purged ${changes} stub gloss row(s) from ${dbPath}`)

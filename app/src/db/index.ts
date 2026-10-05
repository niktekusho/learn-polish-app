import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

// Anchor paths to this module (the app package), not process.cwd(): starting
// the server from the repo root vs app/ must not silently open two different
// DBs. DATABASE_PATH / MIGRATIONS_DIR override for tests/deploys — required for
// the production build, where this module is bundled into dist/server/assets/
// and the relative anchors below point inside dist/ (see `pnpm start`).
const DB_PATH =
  process.env.DATABASE_PATH ?? fileURLToPath(new URL("../../data/app.db", import.meta.url));
const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL("../../drizzle", import.meta.url));

mkdirSync(dirname(DB_PATH), { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

// Run migrations on startup. Cheap for a local-first single-user app;
// no separate migrate step needed in dev.
if (existsSync(MIGRATIONS_DIR)) {
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}

export { schema };

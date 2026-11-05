import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import { recordCall } from "./call-log";

test("a call is stored with its provider, and a long error is cut to 500 characters", () => {
  const db = drizzle(new Database(":memory:"), { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  const call = { call: "episode" as const, model: "m", promptChars: 10, ms: 5 };
  recordCall(db, "claude-cli", { ...call, error: null });
  recordCall(db, "claude-cli", { ...call, error: "x".repeat(900) });

  const rows = db.select().from(schema.llmCall).all();
  expect(rows).toMatchObject([
    { provider: "claude-cli", ...call, error: null },
    { provider: "claude-cli", ...call },
  ]);
  expect(rows[1].error).toHaveLength(500);
});

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import { nameBase } from "./classify";

function dbWithNames(...names: string[]) {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  db.insert(schema.dictEntry)
    .values(names.map((word) => ({ word, pos: "name" })))
    .run();
  return db;
}

test("oblique forms of feminine -a names resolve to the dictionary name", () => {
  const db = dbWithNames("Kasia", "Hanna");
  expect(["Kasi", "Kasię", "Kasią", "kasia", "Hanno", "Hanny"].map((n) => nameBase(db, n))).toEqual(
    ["Kasia", "Kasia", "Kasia", "Kasia", "Hanna", "Hanna"],
  );
});

test("masculine -o names never merge into a feminine dictionary name", () => {
  const db = dbWithNames("Maria", "Antonia");
  expect(["Mario", "Antonio", "Marco", "marco"].map((n) => nameBase(db, n))).toEqual([
    "Mario",
    "Antonio",
    "Marco",
    "Marco",
  ]);
});

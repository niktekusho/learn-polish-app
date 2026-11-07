import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import { getLearnerProfile, hasLearnerProfile, saveLearnerProfile } from "./service";

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  return db;
}

const MINE = {
  name: "Nicola",
  job: "Sviluppatore software",
  city: "Padova",
  partner: "Ola, polacca, di Cracovia",
  hobbies: "Videogiochi e cucina",
};

test("a fresh DB has no learner profile", () => {
  const db = freshDb();
  expect(hasLearnerProfile(db)).toBe(false);
  expect(getLearnerProfile(db)).toBeNull();
});

test("saving stores the profile and reads it back", () => {
  const db = freshDb();
  saveLearnerProfile(db, MINE);
  expect(hasLearnerProfile(db)).toBe(true);
  expect(getLearnerProfile(db)).toEqual(MINE);
});

test("saving again edits the one profile", () => {
  const db = freshDb();
  saveLearnerProfile(db, MINE);
  saveLearnerProfile(db, { ...MINE, city: "Varsavia", hobbies: "" });
  expect(getLearnerProfile(db)).toEqual({ ...MINE, city: "Varsavia", hobbies: "" });
  expect(db.select().from(schema.learnerProfile).all()).toHaveLength(1);
});

test("saving trims each field", () => {
  const db = freshDb();
  saveLearnerProfile(db, { ...MINE, name: "  Nicola ", job: " " });
  expect(getLearnerProfile(db)).toMatchObject({ name: "Nicola", job: "" });
});

test("the schema refuses a second profile row", () => {
  const db = freshDb();
  saveLearnerProfile(db, MINE);
  expect(() =>
    db
      .insert(schema.learnerProfile)
      .values({ ...MINE, id: 2 })
      .run(),
  ).toThrow(/CHECK constraint/);
});

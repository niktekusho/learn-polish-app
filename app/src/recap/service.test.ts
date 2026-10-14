import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import { Rating, gradeLemma } from "#/fsrs/index";
import { getRecap, recordActivity } from "./service";

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  return db;
}
type DB = ReturnType<typeof freshDb>;

const TODAY = new Date(2026, 9, 14, 20, 0); // local evening
const YESTERDAY = new Date(2026, 9, 13, 9, 0);

function addLemma(db: DB, word: string) {
  return db
    .insert(schema.lemma)
    .values({ lemma: word, pos: "NOUN" })
    .returning({ id: schema.lemma.id })
    .all()[0].id;
}

function review(
  db: DB,
  lemmaId: number,
  at: Date,
  before: number | null,
  after: number | null,
  track: "receptive" | "productive" = "receptive",
) {
  db.insert(schema.reviewLog)
    .values({
      lemmaId,
      track,
      rating: 3,
      stateBefore: 2,
      stateAfter: 2,
      stabilityBefore: before,
      stabilityAfter: after,
      reviewedAt: at,
    })
    .run();
}

test("new words are lemmas whose first-ever review is today, legacy rows included", () => {
  const db = freshDb();
  const kot = addLemma(db, "kot");
  const pies = addLemma(db, "pies");
  const dom = addLemma(db, "dom");
  review(db, kot, TODAY, 0, 2);
  review(db, pies, YESTERDAY, null, null); // legacy row: seen before today
  review(db, pies, TODAY, 2, 5);
  review(db, dom, TODAY, null, null); // legacy-shaped but first ever
  review(db, dom, TODAY, null, null, "productive");

  expect(getRecap(db, TODAY).newWords).toBe(2);
});

test("stronger counts distinct lemmas whose stability grew today, 3 biggest gains as examples", () => {
  const db = freshDb();
  const ids = ["kot", "pies", "dom", "woda", "las"].map((w) => addLemma(db, w));
  const [kot, pies, dom, woda, las] = ids;
  review(db, kot, TODAY, 1, 2); // +1
  review(db, kot, TODAY, 1, 3, "productive"); // same lemma, other track
  review(db, pies, TODAY, 2, 12); // +10
  review(db, dom, TODAY, 3, 8); // +5
  review(db, woda, TODAY, 5, 4); // dropped: not stronger
  review(db, las, TODAY, null, null); // legacy: never stronger
  review(db, las, YESTERDAY, 1, 30); // another day

  const { stronger } = getRecap(db, TODAY);
  expect(stronger.count).toBe(3);
  expect(stronger.examples).toEqual(["pies", "dom", "kot"]);
});

test("matured counts lemmas crossing 21 days today, once per lemma across tracks", () => {
  const db = freshDb();
  const kot = addLemma(db, "kot");
  const pies = addLemma(db, "pies");
  const dom = addLemma(db, "dom");
  review(db, kot, TODAY, 15, 25);
  review(db, kot, TODAY, 18, 22, "productive");
  review(db, pies, TODAY, 21, 40); // already mature
  review(db, dom, YESTERDAY, 10, 30); // crossed on another day

  expect(getRecap(db, TODAY).matured).toEqual({ count: 1, examples: ["kot"] });
});

test("gradeLemma logs stability before and after", () => {
  const db = freshDb();
  const kot = addLemma(db, "kot");
  gradeLemma(db, kot, "receptive", Rating.Good, YESTERDAY);
  gradeLemma(db, kot, "receptive", Rating.Good, TODAY);
  const rows = db.select().from(schema.reviewLog).all();
  expect(rows[0].stabilityBefore).toBe(0);
  expect(rows[0].stabilityAfter).toBeGreaterThan(0);
  expect(rows[1].stabilityBefore).toBe(rows[0].stabilityAfter);
  expect(getRecap(db, TODAY)).toMatchObject({ newWords: 0, stronger: { count: 1 } });
});

test("activity is recorded once per day and kind; both kinds make a complete day", () => {
  const db = freshDb();
  expect(recordActivity(db, "practice", TODAY)).toEqual({ inserted: true, complete: false });
  expect(recordActivity(db, "practice", TODAY)).toEqual({ inserted: false, complete: false });
  expect(db.select().from(schema.dailyActivity).all()).toHaveLength(1);
  expect(getRecap(db, TODAY)).toMatchObject({
    practiceDone: true,
    episodeDone: false,
    complete: false,
  });

  expect(recordActivity(db, "episode", TODAY)).toEqual({ inserted: true, complete: true });
  expect(getRecap(db, TODAY)).toMatchObject({ episodeDone: true, complete: true });
});

function day(offset: number) {
  return new Date(2026, 9, 14 + offset, 12, 0);
}

test("streak counts consecutive days ending today", () => {
  const db = freshDb();
  for (const d of [-3, -2, -1, 0]) recordActivity(db, "practice", day(d));
  recordActivity(db, "episode", day(-1)); // two kinds on one day count once
  expect(getRecap(db, day(0)).streak).toBe(4);
});

test("an empty today does not break the streak; it ends yesterday", () => {
  const db = freshDb();
  for (const d of [-2, -1]) recordActivity(db, "episode", day(d));
  expect(getRecap(db, day(0)).streak).toBe(2);
});

test("a day with nothing done resets the streak", () => {
  const db = freshDb();
  for (const d of [-5, -4, -2]) recordActivity(db, "practice", day(d));
  expect(getRecap(db, day(-2)).streak).toBe(1);
  expect(getRecap(db, day(0)).streak).toBe(0); // yesterday empty, today empty
  recordActivity(db, "practice", day(0));
  expect(getRecap(db, day(0)).streak).toBe(1);
});

test("streak crosses a month boundary", () => {
  const db = freshDb();
  recordActivity(db, "practice", new Date(2026, 9, 31, 22, 0));
  recordActivity(db, "practice", new Date(2026, 10, 1, 7, 0));
  expect(getRecap(db, new Date(2026, 10, 1, 8, 0)).streak).toBe(2);
});

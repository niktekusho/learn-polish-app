import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import {
  Rating,
  dueLemmas,
  gradeLemma,
  initialKnowledgeFields,
  nextPracticeDue,
  trackCounts,
} from "./index";

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  return db;
}

function addLemma(db: ReturnType<typeof freshDb>, word: string) {
  const [{ id }] = db
    .insert(schema.lemma)
    .values({ lemma: word, pos: "NOUN" })
    .returning({ id: schema.lemma.id })
    .all();
  return id;
}

test("grading advances FSRS state deterministically and logs the review", () => {
  const db = freshDb();
  const lemmaId = addLemma(db, "kot");
  const now = new Date("2026-01-01T00:00:00Z");
  db.insert(schema.knowledge)
    .values({ lemmaId, track: "receptive", ...initialKnowledgeFields(now) })
    .run();

  const next = gradeLemma(db, lemmaId, "receptive", Rating.Good, now);
  expect(next.reps).toBe(1);
  expect(next.state).not.toBe(0);
  expect(next.due.getTime()).toBeGreaterThan(now.getTime());

  // review_log got exactly one row for this grade (#3/#8).
  const logs = db.select().from(schema.reviewLog).all();
  expect(logs).toHaveLength(1);
  expect(logs[0].rating).toBe(Rating.Good);
  expect(logs[0].stateBefore).toBe(0);
  expect(logs[0].stateAfter).toBe(next.state);

  // Deterministic.
  const db2 = freshDb();
  const l2 = addLemma(db2, "kot");
  db2
    .insert(schema.knowledge)
    .values({ lemmaId: l2, track: "receptive", ...initialKnowledgeFields(now) })
    .run();
  const again = gradeLemma(db2, l2, "receptive", Rating.Good, now);
  expect(again.due.getTime()).toBe(next.due.getTime());
  expect(again.stability).toBe(next.stability);
});

test("marking known (Easy) moves a new card to Review with a future due date", () => {
  const db = freshDb();
  const lemmaId = addLemma(db, "znany");
  const now = new Date("2026-01-01T00:00:00Z");
  db.insert(schema.knowledge)
    .values({ lemmaId, track: "receptive", ...initialKnowledgeFields(now) })
    .run();

  const next = gradeLemma(db, lemmaId, "receptive", Rating.Easy, now);
  expect(next.state).toBe(2); // State.Review
  expect(next.due.getTime()).toBeGreaterThan(now.getTime());
});

test("gradeLemma creates the row when the track has no state yet", () => {
  const db = freshDb();
  const lemmaId = addLemma(db, "pies");
  gradeLemma(db, lemmaId, "productive", Rating.Again);
  expect(db.select().from(schema.knowledge).all()).toHaveLength(1);
  expect(db.select().from(schema.reviewLog).all()).toHaveLength(1);
});

test("dueLemmas returns reviews before New cards and caps New cards", () => {
  const db = freshDb();
  const now = new Date("2026-01-10T00:00:00Z");
  const past = new Date("2026-01-01T00:00:00Z");

  // Two due reviews (state Review), weakest first.
  for (const [w, stab] of [
    ["rev_strong", 10],
    ["rev_weak", 1],
  ] as const) {
    const id = addLemma(db, w);
    db.insert(schema.knowledge)
      .values({ lemmaId: id, track: "receptive", due: past, stability: stab, state: 2 })
      .run();
  }
  // 15 brand-new cards, all due immediately.
  for (let i = 0; i < 15; i++) {
    const id = addLemma(db, `new_${i}`);
    db.insert(schema.knowledge)
      .values({ lemmaId: id, track: "receptive", due: past, stability: 0, state: 0 })
      .run();
  }

  const due = dueLemmas(db, "receptive", { now, limit: 50, newCardLimit: 10 });

  // Reviews first (weakest first), then New — capped at 10.
  expect(due.slice(0, 2).map((d) => d.lemma)).toEqual(["rev_weak", "rev_strong"]);
  const newCount = due.filter((d) => d.state === 0).length;
  expect(newCount).toBe(10);
  expect(due).toHaveLength(12);
});

test("a card graded today is not due again until tomorrow", () => {
  const db = freshDb();
  const morning = new Date(2026, 0, 1, 8, 0);
  for (const word of ["zle", "dobrze"]) {
    const lemmaId = addLemma(db, word);
    db.insert(schema.knowledge)
      .values({ lemmaId, track: "receptive", ...initialKnowledgeFields(morning) })
      .run();
    gradeLemma(db, lemmaId, "receptive", word === "zle" ? Rating.Again : Rating.Good, morning);
  }

  const evening = new Date(2026, 0, 1, 20, 0);
  expect(dueLemmas(db, "receptive", { now: evening })).toEqual([]);
  const tomorrow = new Date(2026, 0, 2, 7, 0);
  expect(
    dueLemmas(db, "receptive", { now: tomorrow })
      .map((d) => d.lemma)
      .sort(),
  ).toEqual(["dobrze", "zle"]);
  expect(nextPracticeDue(new Date(2026, 0, 1, 8, 10), morning)).toEqual(new Date(2026, 0, 2));
});

test("track counts give each track's reviews due now and its mature lemmas", () => {
  const db = freshDb();
  const now = new Date(2026, 0, 10, 12, 0);
  const card = (
    word: string,
    track: "receptive" | "productive",
    fields: { state: number; stability: number; due: Date; lastReview?: Date },
  ) => {
    const lemmaId = addLemma(db, word);
    db.insert(schema.knowledge)
      .values({ lemmaId, track, ...initialKnowledgeFields(now), ...fields })
      .run();
    return lemmaId;
  };
  const yesterday = new Date(2026, 0, 9);
  card("kot", "receptive", { state: 2, stability: 3, due: yesterday });
  card("pies", "receptive", { state: 2, stability: 30, due: new Date(2026, 1, 1) }); // mature, not due
  card("nowy", "receptive", { state: 0, stability: 0, due: yesterday }); // new: not a review
  card("dzis", "receptive", {
    state: 1,
    stability: 1,
    due: yesterday,
    lastReview: new Date(2026, 0, 10, 9),
  });
  const flagged = card("zly", "receptive", { state: 2, stability: 3, due: yesterday });
  db.update(schema.lemma).set({ flaggedAt: now }).where(eq(schema.lemma.id, flagged)).run();
  card("dom", "productive", { state: 2, stability: 21, due: yesterday }); // due and mature

  expect(trackCounts(db, now)).toEqual({
    receptive: { due: 1, mature: 1 },
    productive: { due: 1, mature: 1 },
    pronunciation: { due: 0, mature: 0 },
  });
});

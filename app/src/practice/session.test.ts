import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq, ne } from "drizzle-orm";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import { dueLemmas, initialKnowledgeFields } from "#/fsrs/index";
import { listContextBound, unmarkContextBound } from "#/maintenance/ops";
import type { GlossProvider, ReportVerdict } from "#/llm/provider";
import { pendingReports, reviewReports } from "#/report/review";
import {
  answerItem,
  buildSession,
  markContextBound,
  reportItem,
  resumeSession,
  sessionSummary,
} from "./session";

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  return db;
}

// Seed a due lemma; give it a cached gloss unless gloss === null.
function seed(db: ReturnType<typeof freshDb>, word: string, glossText: string | null) {
  const due = new Date("2026-01-01T00:00:00Z");
  const [{ id }] = db
    .insert(schema.lemma)
    .values({ lemma: word, pos: "NOUN" })
    .returning({ id: schema.lemma.id })
    .all();
  db.insert(schema.knowledge)
    .values({ lemmaId: id, track: "receptive", ...initialKnowledgeFields(due) })
    .run();
  if (glossText !== null) {
    db.insert(schema.gloss).values({ lemmaId: id, italian: glossText }).run();
  }
  return id;
}

test("buildSession skips un-glossed lemmas and never generates a gloss", () => {
  const db = freshDb();
  seed(db, "kot", "gatto");
  seed(db, "pies", "cane");
  seed(db, "dom", "casa");
  seed(db, "woda", "acqua");
  seed(db, "bezglosu", null); // due but no cached gloss -> skipped

  const glossesBefore = db.select().from(schema.gloss).all().length;
  const session = buildSession(db, { limit: 20 });

  // 4 glossed lemmas -> 4 items; the un-glossed one is skipped.
  expect(session.items).toHaveLength(4);
  // Zero gloss generation in session build (#10/#6).
  expect(db.select().from(schema.gloss).all()).toHaveLength(glossesBefore);
  // Client items carry no correct-answer marker.
  for (const item of session.items) {
    expect("correctIndex" in item).toBe(false);
    expect(item.kind).toBe("recognition-mcq");
    if (item.kind === "recognition-mcq") expect(item.choices).toHaveLength(4);
  }
});

test("answering grades exactly once; a repeat submit is rejected", () => {
  const db = freshDb();
  for (const [w, g] of [
    ["kot", "gatto"],
    ["pies", "cane"],
    ["dom", "casa"],
    ["woda", "acqua"],
  ] as const) {
    seed(db, w, g);
  }
  const session = buildSession(db, { limit: 20 });
  const first = session.items[0];

  const r1 = answerItem(db, session.sessionId, first.id, 0);
  expect(r1.alreadyAnswered).toBe(false);
  expect(db.select().from(schema.reviewLog).all()).toHaveLength(1);

  // Repeat submit for the same item: no second FSRS update / review_log row.
  const r2 = answerItem(db, session.sessionId, first.id, 1);
  expect(r2.alreadyAnswered).toBe(true);
  expect(r2.correct).toBe(r1.correct);
  expect(db.select().from(schema.reviewLog).all()).toHaveLength(1);
});

test("resumeSession returns the held items and answered progress", () => {
  const db = freshDb();
  const { session, first, right } = seedFourAndBuild(db);
  answerItem(db, session.sessionId, first.id, right);

  const resumed = resumeSession(session.sessionId);
  expect(resumed).not.toBeNull();
  expect(resumed?.items).toHaveLength(session.items.length);
  expect(resumed?.answered).toHaveLength(1);
  expect(resumeSession("nope")).toBeNull();
});

function verdictProvider(v: ReportVerdict): GlossProvider {
  return {
    name: "claude-cli",
    gloss: async () => "",
    reviewReports: async (items) => items.map(() => v),
  };
}

test("report flags the lemma out of practice without grading; its review brings it back", async () => {
  const db = freshDb();
  for (const [w, g] of [
    ["kot", "gatto"],
    ["pies", "cane"],
    ["dom", "casa"],
    ["woda", "acqua"],
    ["tylko", "ma anche"],
  ] as const) {
    seed(db, w, g);
  }
  const session = buildSession(db, { limit: 20 });
  const bad = session.items.find((i) => i.kind === "recognition-mcq" && i.prompt === "tylko")!;
  reportItem(db, session.sessionId, bad.id, "  wrong gloss  ");

  expect(db.select().from(schema.reviewLog).all()).toHaveLength(0); // no FSRS write
  expect(resumeSession(session.sessionId)!.answered).toEqual([{ itemId: bad.id, correct: false }]);
  expect(pendingReports(db)).toMatchObject([
    { lemma: "tylko", kind: "wrong", note: "wrong gloss" },
  ]);

  // Flagged: neither a target nor a distractor.
  const next = buildSession(db, { limit: 20 });
  expect(next.items).toHaveLength(4);
  for (const i of next.items) {
    if (i.kind !== "recognition-mcq") continue;
    expect(i.prompt).not.toBe("tylko");
    expect(i.choices).not.toContain("ma anche");
  }
  await reviewReports(
    db,
    verdictProvider({
      gloss: { italian: "solo", noSenseFits: true },
      contextBound: false,
      reason: "Glossa sbagliata.",
    }),
  );
  expect(pendingReports(db)).toHaveLength(0);
  const after = buildSession(db, { limit: 20 });
  const fixed = after.items.find((i) => i.kind === "recognition-mcq" && i.prompt === "tylko");
  expect(fixed?.kind === "recognition-mcq" && fixed.choices).toContain("solo");
});

test("needs context drops the lemma from single-word exercises but keeps read-aloud; unmark restores it", () => {
  const db = freshDb();
  for (const [w, g] of [
    ["kot", "gatto"],
    ["pies", "cane"],
    ["dom", "casa"],
    ["woda", "acqua"],
    ["do", "per"],
  ] as const) {
    seed(db, w, g);
  }
  const doId = db
    .select()
    .from(schema.lemma)
    .all()
    .find((l) => l.lemma === "do")!.id;
  db.insert(schema.knowledge)
    .values({
      lemmaId: doId,
      track: "pronunciation",
      ...initialKnowledgeFields(new Date("2026-01-01")),
    })
    .run();
  const session = buildSession(db, { limit: 20 });
  const item = session.items.find((i) => i.kind === "recognition-mcq" && i.prompt === "do")!;
  markContextBound(db, session.sessionId, item.id);

  expect(db.select().from(schema.reviewLog).all()).toHaveLength(0);
  expect(pendingReports(db)).toMatchObject([{ lemma: "do", kind: "context" }]);
  expect(listContextBound(db)).toMatchObject([{ lemma: "do" }]);
  expect(dueLemmas(db, "receptive").map((d) => d.lemma)).not.toContain("do");
  expect(dueLemmas(db, "productive").map((d) => d.lemma)).not.toContain("do");
  expect(dueLemmas(db, "pronunciation").map((d) => d.lemma)).toContain("do");

  unmarkContextBound(db, doId);
  expect(dueLemmas(db, "receptive").map((d) => d.lemma)).toContain("do");
});

const GLOSS: Record<string, string> = { kot: "gatto", pies: "cane", dom: "casa", woda: "acqua" };

function seedFourAndBuild(db: ReturnType<typeof freshDb>) {
  for (const [w, g] of Object.entries(GLOSS)) seed(db, w, g);
  const session = buildSession(db, { limit: 20 });
  const first = session.items[0];
  if (first.kind !== "recognition-mcq") throw new Error("expected an MCQ");
  const wrong = first.choices.findIndex((c) => c !== GLOSS[first.prompt]);
  const right = first.choices.indexOf(GLOSS[first.prompt]);
  return { session, first, wrong, right };
}

test("a missed MCQ queues one Retry at the end; the Retry grades nothing and is never retried", () => {
  const db = freshDb();
  const { session, first, wrong } = seedFourAndBuild(db);

  const res = answerItem(db, session.sessionId, first.id, wrong);
  expect(res.correct).toBe(false);
  expect(res.retry).toMatchObject({ kind: "recognition-mcq", prompt: first.prompt, retry: true });
  expect(res.retry?.id).not.toBe(first.id);
  const held = resumeSession(session.sessionId)!;
  expect(held.items).toHaveLength(session.items.length + 1);
  expect(held.items.at(-1)?.id).toBe(res.retry?.id);

  const knowledgeBefore = db.select().from(schema.knowledge).all();
  const retry = res.retry!;
  if (retry.kind !== "recognition-mcq") throw new Error("expected an MCQ retry");
  const retryWrong = retry.choices.findIndex((c) => c !== GLOSS[retry.prompt]);
  const again = answerItem(db, session.sessionId, retry.id, retryWrong);
  expect(again.correct).toBe(false);
  expect(again.retry).toBeUndefined();
  expect(db.select().from(schema.reviewLog).all()).toHaveLength(1);
  expect(db.select().from(schema.knowledge).all()).toEqual(knowledgeBefore);
});

test("a correct MCQ answer queues no Retry", () => {
  const db = freshDb();
  const { session, first, right } = seedFourAndBuild(db);
  expect(answerItem(db, session.sessionId, first.id, right).retry).toBeUndefined();
  expect(resumeSession(session.sessionId)!.items).toHaveLength(session.items.length);
});

test("reporting a missed item drops its pending Retry", () => {
  const db = freshDb();
  const { session, first, wrong } = seedFourAndBuild(db);
  const { retry } = answerItem(db, session.sessionId, first.id, wrong);

  expect(reportItem(db, session.sessionId, first.id, "wrong gloss")).toEqual({
    dropped: [retry?.id],
  });
  expect(resumeSession(session.sessionId)!.items).toHaveLength(session.items.length);
});

function answerAll(db: ReturnType<typeof freshDb>, sessionId: string) {
  for (let s = resumeSession(sessionId)!; ; s = resumeSession(sessionId)!) {
    const done = new Set(s.answered.map((a) => a.itemId));
    const next = s.items.find((i) => !done.has(i.id));
    if (!next) return;
    answerItem(db, sessionId, next.id, 0); // some right, some wrong: Retries join in
  }
}

test("finishing a session, Retries included, records the day's practice once", () => {
  const db = freshDb();
  for (const [w, g] of Object.entries(GLOSS)) seed(db, w, g);
  const session = buildSession(db, { limit: 20 });
  const [first, ...rest] = session.items;
  answerItem(db, session.sessionId, first.id, 0);
  expect(db.select().from(schema.dailyActivity).all()).toHaveLength(0);
  for (const i of rest) answerItem(db, session.sessionId, i.id, 0);

  answerAll(db, session.sessionId);
  expect(db.select().from(schema.dailyActivity).all()).toMatchObject([{ kind: "practice" }]);
  expect(sessionSummary(db, session.sessionId)).toMatchObject({
    line: expect.stringMatching(/^\+\d+ parol/),
    first: true,
  });
  expect(sessionSummary(db, session.sessionId)).toMatchObject({
    first: false,
    dayCompleted: false,
  });

  // Graded today: a second session needs fresh dues.
  for (const [w, g] of Object.entries({
    las: "bosco",
    ryba: "pesce",
    sok: "succo",
    ser: "formaggio",
  })) {
    seed(db, w, g);
  }
  const second = buildSession(db, { limit: 20 });
  expect(second.items.length).toBeGreaterThan(0);
  answerAll(db, second.sessionId);
  expect(db.select().from(schema.dailyActivity).all()).toHaveLength(1);
});

test("an unfinished session records nothing", () => {
  const db = freshDb();
  const { session, first, right } = seedFourAndBuild(db);
  answerItem(db, session.sessionId, first.id, right);
  expect(db.select().from(schema.dailyActivity).all()).toHaveLength(0);
  expect(sessionSummary(db, session.sessionId)).toBeNull();
});

function addPassage(db: ReturnType<typeof freshDb>, lemmaId: number, target: string) {
  return db
    .insert(schema.passageQuestion)
    .values({
      lemmaId,
      passage: `Idę ${target} sklepu. Kupuję chleb.`,
      target,
      source: "generated",
      question: "Dove va la persona?",
      choices: ["al negozio", "a casa", "a scuola"],
      correctIndex: 0,
      provider: "stub",
    })
    .returning({ id: schema.passageQuestion.id })
    .all()[0].id;
}

test("a context-bound lemma with a passage is asked through Passage, never MCQ", () => {
  const db = freshDb();
  for (const [w, g] of Object.entries(GLOSS)) seed(db, w, g);
  const doId = seed(db, "do", "a");
  db.update(schema.lemma).set({ contextBound: true }).run();
  db.update(schema.lemma).set({ contextBound: false }).where(ne(schema.lemma.id, doId)).run();
  const before = db.select().from(schema.passageQuestion).all();

  const unprepared = buildSession(db, { limit: 20 });
  expect(unprepared.items.map((i) => i.kind === "recognition-mcq" && i.prompt)).not.toContain("do");

  addPassage(db, doId, "do");
  for (const r of [0.1, 0.9]) {
    const s = buildSession(db, { limit: 20, rng: () => r });
    const asked = s.items.filter(
      (i) =>
        (i.kind === "passage" && i.target === "do") ||
        (i.kind === "recognition-mcq" && i.prompt === "do"),
    );
    expect(asked.map((i) => i.kind)).toEqual(["passage"]);
  }
  expect(db.select().from(schema.passageQuestion).all()).toHaveLength(before.length + 1);
});

test("with both applicable, the random source picks MCQ or Passage", () => {
  const db = freshDb();
  for (const [w, g] of Object.entries(GLOSS)) seed(db, w, g);
  const kot = db
    .select()
    .from(schema.lemma)
    .all()
    .find((l) => l.lemma === "kot")!;
  addPassage(db, kot.id, "kota");
  const kinds = [0.1, 0.9].map((r) => {
    const s = buildSession(db, { limit: 20, rng: () => r });
    return s.items.find(
      (i) =>
        (i.kind === "passage" && i.target === "kota") ||
        (i.kind === "recognition-mcq" && i.prompt === "kot"),
    )?.kind;
  });
  expect(new Set(kinds)).toEqual(new Set(["passage", "recognition-mcq"]));
});

function passageSession(db: ReturnType<typeof freshDb>) {
  for (const [w, g] of Object.entries(GLOSS)) seed(db, w, g);
  const doId = seed(db, "do", "a");
  db.update(schema.lemma).set({ contextBound: true }).where(eq(schema.lemma.id, doId)).run();
  const questionId = addPassage(db, doId, "do");
  const session = buildSession(db, { limit: 20 });
  const item = session.items.find((i) => i.kind === "passage")!;
  if (item.kind !== "passage") throw new Error("expected a passage");
  return { session, item, doId, questionId };
}

test("a passage answer grades receptive; a miss queues a Passage Retry", () => {
  const db = freshDb();
  const { session, item, doId } = passageSession(db);
  const wrong = item.choices.findIndex((c) => c !== "al negozio");

  const res = answerItem(db, session.sessionId, item.id, wrong);
  expect(res.correct).toBe(false);
  expect(item.choices[res.correctIndex]).toBe("al negozio");
  expect(res.retry).toMatchObject({ kind: "passage", target: "do", retry: true });
  expect(db.select().from(schema.reviewLog).all()).toMatchObject([
    { lemmaId: doId, track: "receptive", rating: 1 },
  ]);
});

test("reporting a passage deletes its question so it is prepared again", () => {
  const db = freshDb();
  const { session, item, doId } = passageSession(db);
  reportItem(db, session.sessionId, item.id, "");
  expect(db.select().from(schema.passageQuestion).all()).toHaveLength(0);
  expect(pendingReports(db).filter((p) => p.kind === "wrong")).toHaveLength(0);
  expect(dueLemmas(db, "receptive").map((d) => d.lemmaId)).not.toContain(doId);
});

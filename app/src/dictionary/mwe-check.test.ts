import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import { persistAnalysis } from "#/import/pipeline";
import { pruneOrphanLemmas } from "#/maintenance/ops";
import type { AnalyzeResponse } from "#/import/sidecar";
import type { MweCheckItem } from "#/llm/provider";
import { importAnalysis } from "#/import/checked-import";
import { recheckMwes, restoreMwe, suppressMwe } from "./mwe-check";

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  return db;
}

function w(surface: string, lemma: string, pos: string) {
  return { surface, lemma, pos, tags: [], is_space: false };
}

const HEADWORDS = new Map([
  ["to", ["to jest"]],
  ["dzień", ["dzień dobry"]],
]);

const ANALYSIS: AnalyzeResponse = {
  sentences: [
    { tokens: [w("To ", "to", "PRON"), w("jest ", "być", "AUX"), w("chleb", "chleb", "NOUN")] },
    { tokens: [w("Dzień ", "dzień", "NOUN"), w("dobry", "dobry", "ADJ")] },
  ],
};

/** Throws on the first `fail` calls, then rejects every "To jest …" sentence; records each call. */
function fakeProvider(fail = 0) {
  const calls: MweCheckItem[][] = [];
  return {
    name: "stub" as const,
    calls,
    async checkMwes(items: MweCheckItem[]) {
      calls.push(items);
      if (calls.length <= fail) throw new Error("claude exited 1");
      return items.map((i) => !i.sentence.startsWith("To jest"));
    },
  };
}

const NO_CHECK = { name: "stub" as const };

function importChecked(
  db: ReturnType<typeof freshDb>,
  analysis: AnalyzeResponse,
  checker: Parameters<typeof importAnalysis>[1] = fakeProvider(),
) {
  return importAnalysis(db, checker, { content: "x" }, analysis, HEADWORDS);
}

function rowCounts(db: ReturnType<typeof freshDb>) {
  return [
    schema.sourceText,
    schema.token,
    schema.mweOccurrence,
    schema.lemma,
    schema.knowledge,
  ].map((t) => db.select().from(t).all().length);
}

function headwordsLeft(db: ReturnType<typeof freshDb>) {
  return db
    .select({ headword: schema.lemma.lemma })
    .from(schema.mweOccurrence)
    .innerJoin(schema.lemma, eq(schema.mweOccurrence.lemmaId, schema.lemma.id))
    .all()
    .map((r) => r.headword);
}

function mweKnowledge(db: ReturnType<typeof freshDb>, headword: string) {
  return db
    .select()
    .from(schema.knowledge)
    .innerJoin(schema.lemma, eq(schema.knowledge.lemmaId, schema.lemma.id))
    .where(eq(schema.lemma.lemma, headword))
    .all();
}

test("a rejected match is never saved and its expression never reaches Practice", async () => {
  const db = freshDb();
  const result = await importChecked(db, ANALYSIS);

  expect(result.mweCount).toBe(1);
  expect(headwordsLeft(db)).toEqual(["dzień dobry"]);
  expect(mweKnowledge(db, "to jest")).toHaveLength(0);
  expect(mweKnowledge(db, "dzień dobry")).toHaveLength(1);
});

test("a check that fails 3 times fails the import with nothing saved", async () => {
  const db = freshDb();
  const provider = fakeProvider(3);

  await expect(importChecked(db, ANALYSIS, provider)).rejects.toThrow(/stub.*claude exited 1/);
  expect(provider.calls).toHaveLength(3);
  expect(rowCounts(db)).toEqual([0, 0, 0, 0, 0]);
});

test("a check that fails twice is retried", async () => {
  const db = freshDb();
  await importChecked(db, ANALYSIS, fakeProvider(2));
  expect(headwordsLeft(db)).toEqual(["dzień dobry"]);
});

test("a provider without the check fails an import with matches", async () => {
  const db = freshDb();
  await expect(importChecked(db, ANALYSIS, NO_CHECK)).rejects.toThrow(/stub/);
  expect(rowCounts(db)).toEqual([0, 0, 0, 0, 0]);
});

test("an import without matches never calls the check", async () => {
  const db = freshDb();
  const plain: AnalyzeResponse = { sentences: [{ tokens: [w("Kot", "kot", "NOUN")] }] };
  const provider = fakeProvider(3);

  await importChecked(db, plain, provider);
  await importChecked(db, plain, NO_CHECK);
  expect(provider.calls).toHaveLength(0);
  expect(db.select().from(schema.sourceText).all()).toHaveLength(2);
});

test("one call per check, identical sentences sent once", async () => {
  const db = freshDb();
  const repeated: AnalyzeResponse = {
    sentences: [ANALYSIS.sentences[0], ANALYSIS.sentences[0], ANALYSIS.sentences[1]],
  };
  const provider = fakeProvider();

  await importChecked(db, repeated, provider);
  expect(provider.calls).toHaveLength(1);
  expect(provider.calls[0].map((i) => i.sentence)).toEqual(["To jest chleb", "Dzień dobry"]);
});

test("a recheck drops past rejected matches; a failed recheck changes nothing", async () => {
  const db = freshDb();
  persistAnalysis(db, { content: "x" }, ANALYSIS, new Date(), HEADWORDS);

  await expect(recheckMwes(db, fakeProvider(3))).rejects.toThrow(/stub/);
  await expect(recheckMwes(db, NO_CHECK)).rejects.toThrow(/stub/);
  expect(headwordsLeft(db).sort()).toEqual(["dzień dobry", "to jest"]);

  expect(await recheckMwes(db, fakeProvider())).toBe(1);
  expect(headwordsLeft(db)).toEqual(["dzień dobry"]);
  expect(mweKnowledge(db, "to jest")).toHaveLength(0);
});

test("a suppressed MWE disappears and later imports skip it; restore rechecks past texts", async () => {
  const db = freshDb();
  for (const word of ["to jest", "dzień dobry"]) {
    db.insert(schema.dictEntry).values({ word, pos: "phrase", isMwe: true }).run();
  }
  const apposition: AnalyzeResponse = {
    sentences: [
      {
        tokens: [
          w("Kot", "kot", "NOUN"),
          w(", ", ",", "PUNCT"),
          w("to ", "to", "PRON"),
          w("jest ", "być", "AUX"),
          w("zwierzę", "zwierzę", "NOUN"),
        ],
      },
    ],
  };
  persistAnalysis(db, { content: "x" }, ANALYSIS);
  persistAnalysis(db, { content: "y" }, apposition);
  const [toJest] = db.select().from(schema.lemma).where(eq(schema.lemma.lemma, "to jest")).all();

  db.insert(schema.gloss).values({ lemmaId: toJest.id, italian: "cioè" }).run();
  const [chleb] = db.select().from(schema.lemma).where(eq(schema.lemma.lemma, "chleb")).all();
  suppressMwe(db, chleb.id);
  suppressMwe(db, toJest.id);
  expect(headwordsLeft(db)).toEqual(["dzień dobry"]);
  // A gloss would make Practice seed the MWE a new productive card.
  expect(db.select().from(schema.gloss).all()).toHaveLength(0);
  expect(db.select().from(schema.lemma).where(eq(schema.lemma.suppressed, true)).all()).toEqual([
    expect.objectContaining({ lemma: "to jest" }),
  ]);
  expect(mweKnowledge(db, "to jest")).toHaveLength(0);
  persistAnalysis(db, { content: "z" }, apposition);
  expect(headwordsLeft(db)).toEqual(["dzień dobry"]);
  pruneOrphanLemmas(db);
  expect(db.select().from(schema.lemma).where(eq(schema.lemma.id, toJest.id)).all()).toHaveLength(
    1,
  );

  await expect(restoreMwe(db, fakeProvider(3), toJest.id)).rejects.toThrow(/stub/);
  await expect(restoreMwe(db, NO_CHECK, toJest.id)).rejects.toThrow(/stub/);
  expect(headwordsLeft(db)).toEqual(["dzień dobry"]);
  expect(db.select().from(schema.lemma).where(eq(schema.lemma.id, toJest.id)).all()).toEqual([
    expect.objectContaining({ suppressed: true }),
  ]);

  const provider = fakeProvider();
  await restoreMwe(db, provider, toJest.id);
  expect(provider.calls).toHaveLength(1);
  expect(provider.calls[0].map((i) => i.sentence)).toEqual([
    "To jest chleb",
    "Kot, to jest zwierzę",
  ]);
  expect(headwordsLeft(db).sort()).toEqual(["dzień dobry", "to jest", "to jest"]);
  expect(mweKnowledge(db, "to jest")).toHaveLength(1);
});

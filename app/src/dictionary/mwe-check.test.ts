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
import { checkMweOccurrences, restoreMwe, suppressMwe } from "./mwe-check";

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

/** Rejects every "To jest …" sentence, keeps the rest; records each call. */
function fakeProvider() {
  const calls: MweCheckItem[][] = [];
  return {
    calls,
    async checkMwes(items: MweCheckItem[]) {
      calls.push(items);
      return items.map((i) => !i.sentence.startsWith("To jest"));
    },
  };
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

test("a rejected match is dropped and its expression leaves Practice", async () => {
  const db = freshDb();
  const { textId } = persistAnalysis(db, { content: "x" }, ANALYSIS, new Date(), HEADWORDS);

  await checkMweOccurrences(db, fakeProvider(), { textId });

  expect(headwordsLeft(db)).toEqual(["dzień dobry"]);
  expect(mweKnowledge(db, "to jest")).toHaveLength(0);
  expect(mweKnowledge(db, "dzień dobry")).toHaveLength(1);
});

test("a failed or missing check keeps every match", async () => {
  const db = freshDb();
  const { textId } = persistAnalysis(db, { content: "x" }, ANALYSIS, new Date(), HEADWORDS);

  const failing = {
    async checkMwes(): Promise<boolean[]> {
      throw new Error("claude exited 1");
    },
  };
  expect(await checkMweOccurrences(db, failing, { textId })).toBe(0);
  expect(await checkMweOccurrences(db, {}, { textId })).toBe(0);

  expect(headwordsLeft(db).sort()).toEqual(["dzień dobry", "to jest"]);
});

test("one call per check, identical sentences sent once, none without matches", async () => {
  const db = freshDb();
  const repeated: AnalyzeResponse = {
    sentences: [ANALYSIS.sentences[0], ANALYSIS.sentences[0], ANALYSIS.sentences[1]],
  };
  const { textId } = persistAnalysis(db, { content: "x" }, repeated, new Date(), HEADWORDS);
  const provider = fakeProvider();

  expect(await checkMweOccurrences(db, provider, { textId })).toBe(2);
  expect(provider.calls).toHaveLength(1);
  expect(provider.calls[0].map((i) => i.sentence)).toEqual(["To jest chleb", "Dzień dobry"]);

  const plain = persistAnalysis(
    db,
    { content: "y" },
    { sentences: [{ tokens: [w("Kot", "kot", "NOUN")] }] },
    new Date(),
    HEADWORDS,
  );
  await checkMweOccurrences(db, provider, { textId: plain.textId });
  expect(provider.calls).toHaveLength(1);
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

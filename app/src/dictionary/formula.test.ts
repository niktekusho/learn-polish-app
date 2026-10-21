import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import { getGloss } from "#/gloss/service";
import { persistAnalysis } from "#/import/pipeline";
import type { AnalyzeResponse } from "#/import/sidecar";
import type { GlossProvider, MweCheckItem } from "#/llm/provider";
import { insertEntryBatch } from "./loader";
import { repairFormulas, resolveFormulas } from "./formula";

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  return db;
}
type DB = ReturnType<typeof freshDb>;

function w(surface: string, lemma: string, pos: string) {
  return { surface, lemma, pos, tags: [], is_space: false };
}

function entry(word: string, pos: string, senses: string[]) {
  return {
    word,
    pos,
    ipa: null,
    etymology: null,
    isMwe: false,
    senses: senses.map((gloss) => ({ gloss, rawGloss: null, tags: [] })),
    forms: [],
  };
}

function seedDictionary(db: DB) {
  insertEntryBatch(db, [
    entry("proszę", "intj", ["please", "here you are"]),
    entry("prosić", "verb", ["to ask"]),
    entry("tak", "intj", ["yes"]),
    entry("chleb", "noun", ["bread"]),
  ]);
}

const FORMULA: AnalyzeResponse = {
  sentences: [
    {
      tokens: [
        w("– ", "–", "PUNCT"),
        w("Proszę ", "prosić", "VERB"),
        w("– ", "–", "PUNCT"),
        w("mówi ", "mówić", "VERB"),
        w("Marco", "Marco", "PROPN"),
        w(".", ".", "PUNCT"),
      ],
    },
  ],
};

const VERB: AnalyzeResponse = {
  sentences: [
    { tokens: [w("Proszę ", "prosić", "VERB"), w("o ", "o", "ADP"), w("chleb", "chleb", "NOUN")] },
  ],
};

/** Accepts every candidate except in sentences asking for something ("o"). */
function fakeChecker(fail = 0) {
  const calls: MweCheckItem[][] = [];
  return {
    name: "stub" as const,
    calls,
    async checkMwes(items: MweCheckItem[]) {
      calls.push(items);
      if (calls.length <= fail) throw new Error("bad JSON");
      return items.map((i) => !i.sentence.includes(" o "));
    },
  };
}

async function importText(db: DB, analysis: AnalyzeResponse, checker = fakeChecker()) {
  const formulas = await resolveFormulas(db, checker, analysis);
  return persistAnalysis(db, { content: "x" }, analysis, new Date(), new Map(), formulas);
}

function lemmaOf(db: DB, surface: string) {
  return db
    .select({ lemma: schema.lemma.lemma, pos: schema.lemma.pos })
    .from(schema.token)
    .innerJoin(schema.lemma, eq(schema.token.lemmaId, schema.lemma.id))
    .where(eq(schema.token.surface, surface))
    .all();
}

test("an interjection use becomes its own formula unit", async () => {
  const db = freshDb();
  seedDictionary(db);
  const checker = fakeChecker();
  await importText(db, FORMULA, checker);

  expect(lemmaOf(db, "Proszę ")).toEqual([{ lemma: "proszę", pos: "INTJ" }]);
  expect(checker.calls[0]).toEqual([
    { headword: "proszę", meaning: "please; here you are", sentence: "– Proszę – mówi Marco." },
  ]);
});

test("a verb use stays the verb", async () => {
  const db = freshDb();
  seedDictionary(db);
  await importText(db, VERB);
  expect(lemmaOf(db, "Proszę ")).toEqual([{ lemma: "prosić", pos: "VERB" }]);
});

test("a word already lemmatized as itself is never a candidate", async () => {
  const db = freshDb();
  seedDictionary(db);
  const checker = fakeChecker();
  await importText(db, { sentences: [{ tokens: [w("Tak", "tak", "PART")] }] }, checker);
  expect(checker.calls).toHaveLength(0);
});

test("a check that fails 3 times fails the import with nothing saved", async () => {
  const db = freshDb();
  seedDictionary(db);
  await expect(importText(db, FORMULA, fakeChecker(3))).rejects.toThrow(/stub.*bad JSON/);
  expect(db.select().from(schema.sourceText).all()).toHaveLength(0);
});

test("a check that fails twice is retried", async () => {
  const db = freshDb();
  seedDictionary(db);
  await importText(db, FORMULA, fakeChecker(2));
  expect(lemmaOf(db, "Proszę ")).toEqual([{ lemma: "proszę", pos: "INTJ" }]);
});

test("a provider without the check fails an import with candidates", async () => {
  const db = freshDb();
  seedDictionary(db);
  await expect(resolveFormulas(db, { name: "stub" }, FORMULA)).rejects.toThrow(/stub/);
  const noCandidates = { sentences: [{ tokens: [w("chleb", "chleb", "NOUN")] }] };
  expect(await resolveFormulas(db, { name: "stub" }, noCandidates)).toEqual(new Map());
});

test("repair moves past occurrences and deletes the verb left without any", async () => {
  const db = freshDb();
  seedDictionary(db);
  persistAnalysis(db, { content: "x" }, FORMULA, new Date(), new Map());
  const [verb] = db.select().from(schema.lemma).where(eq(schema.lemma.lemma, "prosić")).all();
  db.insert(schema.gloss)
    .values({ lemmaId: verb.id, sense: "", italian: "chiedere", provider: "stub" })
    .run();
  db.insert(schema.reviewLog)
    .values({ lemmaId: verb.id, track: "receptive", rating: 3, stateBefore: 0, stateAfter: 1 })
    .run();

  const out = await repairFormulas(db, fakeChecker());

  expect(out).toEqual({ moved: 1, deletedLemmas: 1 });
  expect(lemmaOf(db, "Proszę ")).toEqual([{ lemma: "proszę", pos: "INTJ" }]);
  expect(db.select().from(schema.lemma).where(eq(schema.lemma.id, verb.id)).all()).toHaveLength(0);
  for (const t of [schema.gloss, schema.reviewLog, schema.knowledge]) {
    expect(db.select().from(t).where(eq(t.lemmaId, verb.id)).all()).toHaveLength(0);
  }
  const [formula] = db.select().from(schema.lemma).where(eq(schema.lemma.lemma, "proszę")).all();
  const know = db
    .select()
    .from(schema.knowledge)
    .where(eq(schema.knowledge.lemmaId, formula.id))
    .all();
  expect(know).toHaveLength(1);
  expect(know[0].state).toBe(0);
});

test("repair keeps a verb that still has verb uses", async () => {
  const db = freshDb();
  seedDictionary(db);
  persistAnalysis(db, { content: "x" }, FORMULA, new Date(), new Map());
  persistAnalysis(db, { content: "y" }, VERB, new Date(), new Map());

  expect(await repairFormulas(db, fakeChecker())).toEqual({ moved: 1, deletedLemmas: 0 });
  expect(
    lemmaOf(db, "Proszę ")
      .map((l) => l.lemma)
      .sort(),
  ).toEqual(["prosić", "proszę"]);
});

test("the formula's inline gloss is chosen from the interjection senses", async () => {
  const db = freshDb();
  seedDictionary(db);
  await importText(db, FORMULA);
  const [formula] = db.select().from(schema.lemma).where(eq(schema.lemma.lemma, "proszę")).all();
  let offered: string[] = [];
  const provider: GlossProvider = {
    name: "stub",
    async gloss() {
      throw new Error("not used");
    },
    async glossSenses(req) {
      offered = req.senses.map((s) => s.gloss);
      return {
        translations: req.senses.map((s) => ({ index: s.index, italian: `IT:${s.gloss}` })),
        bestIndex: 1,
      };
    },
  };
  const res = await getGloss(
    db,
    { lemmaId: formula.id, lemma: "proszę", pos: "INTJ", sentence: "– Proszę – mówi Marco." },
    provider,
  );
  expect(offered).toEqual(["please", "here you are"]);
  expect(res.italian).toBe("IT:here you are");
});

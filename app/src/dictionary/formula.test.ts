import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import { getGloss } from "#/gloss/service";
import { persistAnalysis } from "#/import/pipeline";
import type { AnalyzeResponse } from "#/import/sidecar";
import type { GlossProvider, MweCheckItem, OccurrenceResult } from "#/llm/provider";
import { insertEntryBatch } from "./loader";
import { sentenceText } from "./mwe-check";
import { repairFormulas, resolveFormulas, suppressFormula } from "./formula";

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

function entry(word: string, pos: string, senses: string[], forms: string[] = []) {
  return {
    word,
    pos,
    ipa: null,
    etymology: null,
    isMwe: false,
    senses: senses.map((gloss) => ({ gloss, rawGloss: null, tags: [] })),
    forms: forms.map((form) => ({ form, tags: [] })),
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
        occurrence: { index: 1 },
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

function seedPoprosic(db: DB) {
  insertEntryBatch(db, [
    entry("poprosić", "verb", ["to ask somebody"], ["poproszę"]),
    entry("prosić", "verb", ["to ask"], ["proszę"]),
    entry("proszę", "intj", ["please"]),
    entry("tak", "particle", ["so"]),
    entry("chleb", "noun", ["bread"]),
  ]);
}

const VORREI: OccurrenceResult = { italian: "vorrei", fixed: true, note: "ordinando, cortese" };

function sentence(...words: [string, string, string][]): AnalyzeResponse {
  return { sentences: [{ tokens: words.map(([s, l, p]) => w(s, l, p)) }] };
}
const ORDER = sentence(
  ["Poproszę ", "poprosić", "VERB"],
  ["chleb", "chleb", "NOUN"],
  [".", ".", "PUNCT"],
);
const ORDER_2 = sentence(
  ["Poproszę ", "poprosić", "VERB"],
  ["kawę", "kawa", "NOUN"],
  [".", ".", "PUNCT"],
);
const ASK = sentence(
  ["Poproszę ", "poprosić", "VERB"],
  ["o ", "o", "ADP"],
  ["chleb", "chleb", "NOUN"],
);

/** Answers every occurrence with `pick`; its check rejects sentences asking for something. */
function clickProvider(pick: OccurrenceResult = VORREI, failChecks = 0) {
  const checker = fakeChecker(failChecks);
  return {
    name: "stub",
    calls: checker.calls,
    async gloss() {
      throw new Error("not used");
    },
    async glossSenses(req) {
      return {
        translations: req.senses.map((s) => ({ index: s.index, italian: `IT:${s.gloss}` })),
        bestIndex: 0,
        occurrence: pick,
      };
    },
    async glossOccurrence() {
      return pick;
    },
    checkMwes: checker.checkMwes,
  } satisfies GlossProvider & { calls: MweCheckItem[][] };
}

function store(db: DB, analysis: AnalyzeResponse) {
  return persistAnalysis(db, { content: "x" }, analysis, new Date(), new Map()).textId;
}

async function click(db: DB, provider: GlossProvider, textId: number, surface: string) {
  const [t] = db
    .select({
      id: schema.token.id,
      surface: schema.token.surface,
      sentenceIndex: schema.token.sentenceIndex,
      lemmaId: schema.lemma.id,
      lemma: schema.lemma.lemma,
      pos: schema.lemma.pos,
    })
    .from(schema.token)
    .innerJoin(schema.lemma, eq(schema.token.lemmaId, schema.lemma.id))
    .where(and(eq(schema.token.textId, textId), eq(schema.token.surface, surface)))
    .all();
  return getGloss(
    db,
    {
      lemmaId: t.lemmaId,
      lemma: t.lemma,
      pos: t.pos,
      sentence: sentenceText(db, textId, t.sentenceIndex),
      token: { id: t.id, surface: t.surface },
    },
    provider,
  );
}

function unit(db: DB, word: string) {
  return db.select().from(schema.lemma).where(eq(schema.lemma.lemma, word)).all()[0];
}

function lemmaGloss(db: DB, lemmaId: number) {
  return db
    .select()
    .from(schema.gloss)
    .where(and(eq(schema.gloss.lemmaId, lemmaId), eq(schema.gloss.sense, "")))
    .all()[0]?.italian;
}

test("a fixed use with no fitting sense becomes a formula with the note in its gloss", async () => {
  const db = freshDb();
  seedPoprosic(db);
  const textId = store(db, ORDER);

  const res = await click(db, clickProvider(), textId, "Poproszę ");

  const formula = unit(db, "poproszę");
  expect(res).toEqual({
    italian: "vorrei (ordinando, cortese)",
    occurrence: "vorrei",
    formula: { lemmaId: formula.id, lemma: "poproszę", pos: "INTJ" },
    cached: false,
  });
  expect(lemmaOf(db, "Poproszę ")).toEqual([{ lemma: "poproszę", pos: "INTJ" }]);
  const know = db
    .select()
    .from(schema.knowledge)
    .where(eq(schema.knowledge.lemmaId, formula.id))
    .all();
  expect(know.map((k) => k.state)).toEqual([0]);
});

test("a promotion moves the accepted past occurrences and deletes the emptied verb", async () => {
  const db = freshDb();
  seedPoprosic(db);
  const textId = store(db, ORDER);
  store(db, ORDER_2);
  const provider = clickProvider();

  await click(db, provider, textId, "Poproszę ");

  expect(provider.calls).toHaveLength(1);
  expect(provider.calls[0]).toEqual([
    { headword: "poproszę", meaning: "vorrei (ordinando, cortese)", sentence: "Poproszę kawę." },
  ]);
  expect(lemmaOf(db, "Poproszę ")).toEqual([
    { lemma: "poproszę", pos: "INTJ" },
    { lemma: "poproszę", pos: "INTJ" },
  ]);
  expect(unit(db, "poprosić")).toBeUndefined();
});

test("a verb use rejected by the check keeps the verb, whose gloss stays a dictionary sense", async () => {
  const db = freshDb();
  seedPoprosic(db);
  const textId = store(db, ORDER);
  store(db, ASK);

  await click(db, clickProvider(), textId, "Poproszę ");

  const verb = unit(db, "poprosić");
  expect(lemmaGloss(db, verb.id)).toBe("IT:to ask somebody");
  expect(
    lemmaOf(db, "Poproszę ")
      .map((l) => l.lemma)
      .sort(),
  ).toEqual(["poprosić", "poproszę"]);
});

test("free text for a base form is an occurrence gloss, never a formula", async () => {
  const db = freshDb();
  seedPoprosic(db);
  const textId = store(db, sentence(["Tak", "tak", "PART"]));

  const res = await click(db, clickProvider(), textId, "Tak");

  expect(res.occurrence).toBe("vorrei");
  expect(res.formula).toBeUndefined();
  expect(lemmaOf(db, "Tak")).toEqual([{ lemma: "tak", pos: "PART" }]);
});

test("a promotion check that fails 3 times changes no token or unit and names the cause", async () => {
  const db = freshDb();
  seedPoprosic(db);
  const textId = store(db, ORDER);
  store(db, ORDER_2);

  const res = await click(db, clickProvider(VORREI, 3), textId, "Poproszę ");

  expect(res.occurrenceError).toMatch(/Formula check by provider "stub" failed 3 times: bad JSON/);
  expect(res.occurrence).toBeNull();
  expect(lemmaOf(db, "Poproszę ")).toEqual([
    { lemma: "poprosić", pos: "VERB" },
    { lemma: "poprosić", pos: "VERB" },
  ]);
  expect(unit(db, "poproszę")).toBeUndefined();
  expect(db.select().from(schema.occurrenceGloss).all()).toHaveLength(0);
});

test("a later import checks a click-found formula in the one Formula call", async () => {
  const db = freshDb();
  seedPoprosic(db);
  const textId = store(db, ORDER);
  await click(db, clickProvider(), textId, "Poproszę ");
  const checker = fakeChecker();

  await importText(
    db,
    sentence(
      ["Poproszę ", "poprosić", "VERB"],
      ["kawę", "kawa", "NOUN"],
      ["– ", "–", "PUNCT"],
      ["Proszę", "prosić", "VERB"],
    ),
    checker,
  );

  expect(checker.calls).toHaveLength(1);
  expect(checker.calls[0].map((i) => [i.headword, i.meaning])).toEqual([
    ["poproszę", "vorrei (ordinando, cortese)"],
    ["proszę", "please"],
  ]);
  expect(lemmaOf(db, "Poproszę ")).toEqual([
    { lemma: "poproszę", pos: "INTJ" },
    { lemma: "poproszę", pos: "INTJ" },
  ]);
});

test("repair covers click-found formulas", async () => {
  const db = freshDb();
  seedPoprosic(db);
  const textId = store(db, ORDER);
  await click(db, clickProvider(), textId, "Poproszę ");
  store(db, ORDER_2);

  expect(await repairFormulas(db, fakeChecker())).toEqual({ moved: 1, deletedLemmas: 1 });
  expect(lemmaOf(db, "Poproszę ").map((l) => l.lemma)).toEqual(["poproszę", "poproszę"]);
});

test("suppressing a formula returns its tokens to the verb and stops detecting it", async () => {
  const db = freshDb();
  seedPoprosic(db);
  const textId = store(db, ORDER);
  const { formula } = await click(db, clickProvider(), textId, "Poproszę ");

  suppressFormula(db, formula!.lemmaId);

  expect(lemmaOf(db, "Poproszę ")).toEqual([{ lemma: "poprosić", pos: "VERB" }]);
  for (const t of [schema.knowledge, schema.gloss, schema.occurrenceGloss]) {
    expect(db.select().from(t).where(eq(t.lemmaId, formula!.lemmaId)).all()).toHaveLength(0);
  }
  const checker = fakeChecker();
  await importText(db, ORDER_2, checker);
  expect(checker.calls).toHaveLength(0);
  expect(lemmaOf(db, "Poproszę ").map((l) => l.lemma)).toEqual(["poprosić", "poprosić"]);

  const res = await click(db, clickProvider(), textId, "Poproszę ");
  expect(res.formula).toBeUndefined();
  expect(res.occurrence).toBe("vorrei");
});

test("suppressing a dictionary-found formula skips it in imports and repair", async () => {
  const db = freshDb();
  seedPoprosic(db);
  await importText(db, FORMULA);
  const proszę = unit(db, "proszę");

  suppressFormula(db, proszę.id);

  expect(lemmaOf(db, "Proszę ")).toEqual([{ lemma: "prosić", pos: "VERB" }]);
  const checker = fakeChecker();
  await importText(db, FORMULA, checker);
  expect(await repairFormulas(db, checker)).toEqual({ moved: 0, deletedLemmas: 0 });
  expect(checker.calls).toHaveLength(0);
});

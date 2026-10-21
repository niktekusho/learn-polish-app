import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import { insertEntryBatch } from "#/dictionary/loader";
import { senseKey } from "#/dictionary/service";
import { persistAnalysis } from "#/import/pipeline";
import type { GlossProvider, OccurrenceResult } from "#/llm/provider";
import { getGloss, regenerateGloss, setManualGloss } from "./service";

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  return db;
}

function countingProvider(): GlossProvider & { calls: number } {
  return {
    name: "stub",
    calls: 0,
    async gloss(req) {
      this.calls++;
      return `IT:${req.lemma}`;
    },
  };
}

function addLemma(db: ReturnType<typeof freshDb>, word: string) {
  const [{ id }] = db
    .insert(schema.lemma)
    .values({ lemma: word, pos: "NOUN" })
    .returning({ id: schema.lemma.id })
    .all();
  return id;
}

test("first lookup generates + caches (with provider tag); second serves cache", async () => {
  const db = freshDb();
  const lemmaId = addLemma(db, "kot");
  const provider = countingProvider();
  const input = { lemmaId, lemma: "kot", pos: "NOUN", sentence: "Mam kota." };

  const first = await getGloss(db, input, provider);
  expect(first).toEqual({ italian: "IT:kot", occurrence: null, cached: false });
  expect(provider.calls).toBe(1);

  const second = await getGloss(db, input, provider);
  expect(second).toEqual({ italian: "IT:kot", occurrence: null, cached: true });
  expect(provider.calls).toBe(1); // zero extra calls on cache hit

  const [row] = db.select().from(schema.gloss).all();
  expect(row.provider).toBe("stub");
});

test("no sentence context: never generates or caches, returns null", async () => {
  const db = freshDb();
  const lemmaId = addLemma(db, "pies");
  const provider = countingProvider();

  const res = await getGloss(
    db,
    { lemmaId, lemma: "pies", pos: "NOUN", sentence: "   " },
    provider,
  );
  expect(res).toEqual({ italian: null, occurrence: null, cached: false });
  expect(provider.calls).toBe(0);
  expect(db.select().from(schema.gloss).all()).toHaveLength(0);
});

test("no-context caller still reads an existing cached gloss", async () => {
  const db = freshDb();
  const lemmaId = addLemma(db, "dom");
  const provider = countingProvider();
  await getGloss(db, { lemmaId, lemma: "dom", pos: "NOUN", sentence: "To dom." }, provider);

  const res = await getGloss(db, { lemmaId, lemma: "dom", pos: "NOUN", sentence: "" }, provider);
  expect(res).toEqual({ italian: "IT:dom", occurrence: null, cached: true });
  expect(provider.calls).toBe(1);
});

test("manual gloss overrides a cached machine gloss and is not regenerated over", async () => {
  const db = freshDb();
  const lemmaId = addLemma(db, "rzecz");
  const provider = countingProvider();
  const input = { lemmaId, lemma: "rzecz", pos: "NOUN", sentence: "Ciekawe rzeczy." };

  await getGloss(db, input, provider); // machine gloss cached
  setManualGloss(db, lemmaId, "  cosa  ");

  // A no-context read now serves the manual value, tagged 'manual'.
  const res = await getGloss(db, { ...input, sentence: "" }, provider);
  expect(res).toEqual({ italian: "cosa", occurrence: null, cached: true });
  const [row] = db.select().from(schema.gloss).all();
  expect(row.provider).toBe("manual");

  // getGloss with context must NOT overwrite the manual gloss.
  const still = await getGloss(db, input, provider);
  expect(still.italian).toBe("cosa");
});

test("setManualGloss rejects empty input", () => {
  const db = freshDb();
  const lemmaId = addLemma(db, "pies");
  expect(() => setManualGloss(db, lemmaId, "   ")).toThrow();
});

test("regenerate discards even a manual gloss and generates fresh", async () => {
  const db = freshDb();
  const lemmaId = addLemma(db, "kot");
  const provider = countingProvider();
  setManualGloss(db, lemmaId, "gatto-vecchio");

  const res = await regenerateGloss(
    db,
    { lemmaId, lemma: "kot", pos: "NOUN", sentence: "Mam kota." },
    provider,
  );
  expect(res).toEqual({ italian: "IT:kot", occurrence: null, cached: false });
  expect(provider.calls).toBe(1);
});

// --- Hybrid per-sense path (kaikki home dictionary) -------------------------

function senseProvider(bestIndex = 1) {
  return {
    name: "stub",
    calls: 0,
    senseCalls: 0,
    async gloss(req) {
      this.calls++;
      return `IT:${req.lemma}`;
    },
    async glossSenses(req) {
      this.senseCalls++;
      return {
        translations: req.senses.map((s) => ({
          index: s.index,
          italian: `IT-sense:${s.gloss}`,
        })),
        bestIndex,
        occurrence: { index: bestIndex },
      };
    },
  } satisfies GlossProvider & { calls: number; senseCalls: number };
}

function seedDictEntry(db: ReturnType<typeof freshDb>, word: string) {
  insertEntryBatch(db, [
    {
      word,
      pos: "noun",
      ipa: null,
      etymology: null,
      isMwe: false,
      senses: [
        { gloss: "castle", rawGloss: null, tags: [] },
        { gloss: "lock", rawGloss: null, tags: [] },
        { gloss: "zipper", rawGloss: null, tags: [] },
      ],
      forms: [],
    },
  ]);
}

test("hybrid: one call writes per-sense rows + best sense as inline gloss", async () => {
  const db = freshDb();
  const lemmaId = addLemma(db, "zamek");
  seedDictEntry(db, "zamek");
  const provider = senseProvider(1); // "lock" fits the sentence

  const res = await getGloss(
    db,
    { lemmaId, lemma: "zamek", pos: "NOUN", sentence: "Zamek w drzwiach." },
    provider,
  );
  expect(res).toEqual({ italian: "IT-sense:lock", occurrence: null, cached: false });
  expect(provider.senseCalls).toBe(1);
  expect(provider.calls).toBe(0); // sentence-context path never ran

  const rows = db.select().from(schema.gloss).all();
  expect(rows).toHaveLength(4); // 3 per-sense + 1 inline (sense='')
  const inline = rows.find((r) => r.sense === "");
  expect(inline?.italian).toBe("IT-sense:lock");
  expect(rows.find((r) => r.sense === senseKey("castle"))?.italian).toBe("IT-sense:castle");

  // Second call: pure cache hit, zero provider calls.
  const again = await getGloss(
    db,
    { lemmaId, lemma: "zamek", pos: "NOUN", sentence: "Zamek w drzwiach." },
    provider,
  );
  expect(again).toEqual({ italian: "IT-sense:lock", occurrence: null, cached: true });
  expect(provider.senseCalls).toBe(1);
});

test("hybrid: lemma not in dictionary falls back to sentence-context path", async () => {
  const db = freshDb();
  const lemmaId = addLemma(db, "pies");
  const provider = senseProvider();

  const res = await getGloss(
    db,
    { lemmaId, lemma: "pies", pos: "NOUN", sentence: "To pies." },
    provider,
  );
  expect(res).toEqual({ italian: "IT:pies", occurrence: null, cached: false });
  expect(provider.senseCalls).toBe(0);
  expect(provider.calls).toBe(1);
  expect(db.select().from(schema.gloss).all()).toHaveLength(1);
});

test("hybrid: pre-existing inline gloss short-circuits, no sense call", async () => {
  const db = freshDb();
  const lemmaId = addLemma(db, "zamek");
  seedDictEntry(db, "zamek");
  setManualGloss(db, lemmaId, "castello");
  const provider = senseProvider();

  const res = await getGloss(
    db,
    { lemmaId, lemma: "zamek", pos: "NOUN", sentence: "Zamek nad rzeką." },
    provider,
  );
  expect(res).toEqual({ italian: "castello", occurrence: null, cached: true });
  expect(provider.senseCalls).toBe(0);
});

test("hybrid: empty sentence stays read-only even for in-dictionary lemmas", async () => {
  const db = freshDb();
  const lemmaId = addLemma(db, "zamek");
  seedDictEntry(db, "zamek");
  const provider = senseProvider();

  const res = await getGloss(
    db,
    { lemmaId, lemma: "zamek", pos: "NOUN", sentence: "  " },
    provider,
  );
  expect(res).toEqual({ italian: null, occurrence: null, cached: false });
  expect(provider.senseCalls).toBe(0);
  expect(db.select().from(schema.gloss).all()).toHaveLength(0);
});

test("hybrid: manual per-sense edit survives (onConflictDoNothing)", async () => {
  const db = freshDb();
  const lemmaId = addLemma(db, "zamek");
  seedDictEntry(db, "zamek");
  // Learner already hand-edited the "lock" sense.
  db.insert(schema.gloss)
    .values({
      lemmaId,
      sense: senseKey("lock"),
      italian: "serratura!",
      provider: "manual",
    })
    .run();
  const provider = senseProvider(0);

  await getGloss(
    db,
    { lemmaId, lemma: "zamek", pos: "NOUN", sentence: "Zamek królewski." },
    provider,
  );
  const lockRow = db
    .select()
    .from(schema.gloss)
    .all()
    .find((r) => r.sense === senseKey("lock"));
  expect(lockRow?.italian).toBe("serratura!");
  expect(lockRow?.provider).toBe("manual");
});

test("regenerate wipes per-sense rows too and re-runs the hybrid path", async () => {
  const db = freshDb();
  const lemmaId = addLemma(db, "zamek");
  seedDictEntry(db, "zamek");
  const provider = senseProvider(2);
  await getGloss(
    db,
    { lemmaId, lemma: "zamek", pos: "NOUN", sentence: "Zamek błyskawiczny." },
    provider,
  );
  expect(db.select().from(schema.gloss).all()).toHaveLength(4);

  const res = await regenerateGloss(
    db,
    { lemmaId, lemma: "zamek", pos: "NOUN", sentence: "Zamek błyskawiczny." },
    provider,
  );
  expect(res.italian).toBe("IT-sense:zipper");
  expect(provider.senseCalls).toBe(2);
  expect(db.select().from(schema.gloss).all()).toHaveLength(4); // fresh set
});

test("a Name is never glossed", async () => {
  const db = freshDb();
  const provider = countingProvider();
  const res = await getGloss(
    db,
    { lemmaId: 1, lemma: "Kasia", pos: "PROPN", sentence: "To jest Kasia." },
    provider,
  );
  expect(res).toEqual({ italian: null, occurrence: null, cached: false });
  expect(provider.calls).toBe(0);
});

function meaningProvider(pick: (sentence: string) => OccurrenceResult, failLater = false) {
  return {
    name: "stub",
    calls: 0,
    async gloss(req) {
      this.calls++;
      return `IT:${req.lemma}`;
    },
    async glossSenses(req) {
      this.calls++;
      return {
        translations: req.senses.map((s) => ({ index: s.index, italian: `IT:${s.gloss}` })),
        bestIndex: 0,
        occurrence: pick(req.sentence),
      };
    },
    async glossOccurrence(req) {
      this.calls++;
      if (failLater) throw new Error("boom");
      return pick(req.sentence);
    },
  } satisfies GlossProvider & { calls: number };
}

function seedDo(db: ReturnType<typeof freshDb>) {
  insertEntryBatch(db, [
    {
      word: "do",
      pos: "prep",
      ipa: null,
      etymology: null,
      isMwe: false,
      senses: ["to, towards", "into, in", "for"].map((gloss) => ({
        gloss,
        rawGloss: null,
        tags: [],
      })),
      forms: [],
    },
  ]);
}

/** Import one sentence and return its tokens. */
function importSentence(db: ReturnType<typeof freshDb>, words: [string, string, string][]) {
  const { textId } = persistAnalysis(
    db,
    { content: "x" },
    {
      sentences: [
        {
          tokens: words.map(([surface, lemma, pos]) => ({
            surface,
            lemma,
            pos,
            tags: [],
            is_space: false,
          })),
        },
      ],
    },
    new Date(),
    new Map(),
  );
  return db.select().from(schema.token).where(eq(schema.token.textId, textId)).all();
}

async function clickDo(
  db: ReturnType<typeof freshDb>,
  tok: typeof schema.token.$inferSelect,
  sentence: string,
  provider: GlossProvider,
) {
  return getGloss(
    db,
    {
      lemmaId: tok.lemmaId!,
      lemma: "do",
      pos: "ADP",
      sentence,
      token: { id: tok.id, surface: tok.surface },
    },
    provider,
  );
}

const DO_PICK = (sentence: string): OccurrenceResult =>
  sentence.includes("piekarni") ? { index: 1 } : { index: 2 };

test("two occurrences show two senses; the lemma gloss stays the dictionary pick", async () => {
  const db = freshDb();
  seedDo(db);
  const [, bakery] = importSentence(db, [
    ["Idzie ", "iść", "VERB"],
    ["do ", "do", "ADP"],
    ["piekarni", "piekarnia", "NOUN"],
  ]);
  const [, gift] = importSentence(db, [
    ["To ", "to", "PRON"],
    ["do ", "do", "ADP"],
    ["mamy", "mama", "NOUN"],
  ]);
  const provider = meaningProvider(DO_PICK);

  const first = await clickDo(db, bakery, "Idzie do piekarni", provider);
  const second = await clickDo(db, gift, "To do mamy", provider);

  expect(first).toEqual({ italian: "IT:to, towards", occurrence: "IT:into, in", cached: false });
  expect(second).toEqual({ italian: "IT:to, towards", occurrence: "IT:for", cached: false });
  const rows = db.select().from(schema.occurrenceGloss).all();
  expect(rows.map((r) => r.sense)).toEqual([senseKey("into, in"), senseKey("for")]);
});

test("the first click makes one provider call; a second click on the token makes none", async () => {
  const db = freshDb();
  seedDo(db);
  const [, tok] = importSentence(db, [
    ["Idzie ", "iść", "VERB"],
    ["do ", "do", "ADP"],
    ["piekarni", "piekarnia", "NOUN"],
  ]);
  const provider = meaningProvider(DO_PICK);

  await clickDo(db, tok, "Idzie do piekarni", provider);
  expect(provider.calls).toBe(1);
  const again = await clickDo(db, tok, "Idzie do piekarni", provider);
  expect(again).toEqual({ italian: "IT:to, towards", occurrence: "IT:into, in", cached: true });
  expect(provider.calls).toBe(1);
});

test("a failed occurrence call shows the lemma gloss and writes no occurrence row", async () => {
  const db = freshDb();
  seedDo(db);
  const [, bakery] = importSentence(db, [
    ["Idzie ", "iść", "VERB"],
    ["do ", "do", "ADP"],
    ["piekarni", "piekarnia", "NOUN"],
  ]);
  const [, gift] = importSentence(db, [
    ["To ", "to", "PRON"],
    ["do ", "do", "ADP"],
    ["mamy", "mama", "NOUN"],
  ]);
  const provider = meaningProvider(DO_PICK, true);
  await clickDo(db, bakery, "Idzie do piekarni", provider);

  const res = await clickDo(db, gift, "To do mamy", provider);

  expect(res).toMatchObject({ italian: "IT:to, towards", occurrence: null });
  expect(res.occurrenceError).toMatch(/stub.*boom/);
  expect(
    db
      .select()
      .from(schema.occurrenceGloss)
      .where(eq(schema.occurrenceGloss.tokenId, gift.id))
      .all(),
  ).toHaveLength(0);
});

test("an out-of-dictionary lemma gets free text, the first time from the lemma call", async () => {
  const db = freshDb();
  const [tok] = importSentence(db, [["Siema", "siema", "INTJ"]]);
  const provider = meaningProvider(() => ({ italian: "ciao", fixed: false, note: null }));

  const res = await getGloss(
    db,
    {
      lemmaId: tok.lemmaId!,
      lemma: "siema",
      pos: "INTJ",
      sentence: "Siema",
      token: { id: tok.id, surface: tok.surface },
    },
    provider,
  );

  expect(res).toEqual({ italian: "IT:siema", occurrence: "IT:siema", cached: false });
  expect(provider.calls).toBe(1);
});

test("regenerate also deletes the lemma's occurrence glosses", async () => {
  const db = freshDb();
  seedDo(db);
  const [, bakery] = importSentence(db, [
    ["Idzie ", "iść", "VERB"],
    ["do ", "do", "ADP"],
    ["piekarni", "piekarnia", "NOUN"],
  ]);
  const [, gift] = importSentence(db, [
    ["To ", "to", "PRON"],
    ["do ", "do", "ADP"],
    ["mamy", "mama", "NOUN"],
  ]);
  const provider = meaningProvider(DO_PICK);
  await clickDo(db, bakery, "Idzie do piekarni", provider);
  await clickDo(db, gift, "To do mamy", provider);

  await regenerateGloss(
    db,
    { lemmaId: gift.lemmaId!, lemma: "do", pos: "ADP", sentence: "To do mamy" },
    provider,
  );

  expect(db.select().from(schema.occurrenceGloss).all()).toHaveLength(0);
});

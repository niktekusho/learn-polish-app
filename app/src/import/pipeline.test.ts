import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import { insertEntryBatch } from "#/dictionary/loader";
import { persistAnalysis } from "./pipeline";
import type { AnalyzeResponse } from "./sidecar";

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  return db;
}

function sp(surface: string) {
  return { surface, lemma: surface, pos: "SPACE", tags: [], is_space: true };
}
function w(surface: string, lemma: string, pos: string, tags: string[] = []) {
  return { surface, lemma, pos, tags, is_space: false };
}

function dict(db: ReturnType<typeof freshDb>, entries: [string, string][]) {
  db.insert(schema.dictEntry)
    .values(entries.map(([word, pos]) => ({ word, pos })))
    .run();
}

// "Robię obiad w kuchni." analyzed (matches the sidecar's #2 acceptance).
const ANALYSIS: AnalyzeResponse = {
  sentences: [
    {
      tokens: [
        w("Robię", "robić", "VERB"),
        sp(" "),
        w("obiad", "obiad", "NOUN"),
        sp(" "),
        w("w", "w", "ADP"),
        sp(" "),
        w("kuchni", "kuchnia", "NOUN"),
        w(".", ".", "PUNCT"),
      ],
    },
  ],
};

test("import creates one text, all tokens, and distinct lemmas with knowledge", () => {
  const db = freshDb();
  const res = persistAnalysis(db, { content: "Robię obiad w kuchni." }, ANALYSIS);

  expect(res.tokenCount).toBe(8);
  expect(res.lemmaCount).toBe(4);

  expect(db.select().from(schema.sourceText).all()).toHaveLength(1);
  expect(db.select().from(schema.token).all()).toHaveLength(8);

  const lemmas = db
    .select()
    .from(schema.lemma)
    .all()
    .map((l) => l.lemma)
    .sort();
  expect(lemmas).toEqual(["kuchnia", "obiad", "robić", "w"]);

  const know = db.select().from(schema.knowledge).all();
  expect(know).toHaveLength(4);
  expect(know.every((k) => k.track === "receptive" && k.state === 0)).toBe(true);

  const punct = db
    .select()
    .from(schema.token)
    .all()
    .find((t) => t.surface === ".");
  expect(punct?.lemmaId).toBeNull();
});

test("re-importing links to existing lemmas without duplicating them", () => {
  const db = freshDb();
  persistAnalysis(db, { content: "x" }, ANALYSIS);
  persistAnalysis(db, { content: "x" }, ANALYSIS);

  expect(db.select().from(schema.sourceText).all()).toHaveLength(2);
  expect(db.select().from(schema.token).all()).toHaveLength(16);
  expect(db.select().from(schema.lemma).all()).toHaveLength(4);
  expect(db.select().from(schema.knowledge).all()).toHaveLength(4);
});

test("detected MWEs become pos=MWE tracked units with occurrences", () => {
  const db = freshDb();
  // "Na pewno tak."
  const analysis: AnalyzeResponse = {
    sentences: [
      {
        tokens: [
          w("Na", "na", "ADP"),
          sp(" "),
          w("pewno", "pewno", "ADV"),
          sp(" "),
          w("tak", "tak", "PART"),
          w(".", ".", "PUNCT"),
        ],
      },
    ],
  };
  const headwords = new Map([["na", ["na pewno"]]]);
  const res = persistAnalysis(db, { content: "Na pewno tak." }, analysis, new Date(), headwords);
  expect(res.mweCount).toBe(1);

  const mweLemma = db
    .select()
    .from(schema.lemma)
    .all()
    .find((l) => l.pos === "MWE");
  expect(mweLemma?.lemma).toBe("na pewno");

  const know = db
    .select()
    .from(schema.knowledge)
    .all()
    .find((k) => k.lemmaId === mweLemma?.id);
  expect(know?.track).toBe("receptive");

  const [occ] = db.select().from(schema.mweOccurrence).all();
  expect(occ.lemmaId).toBe(mweLemma?.id);
  expect(occ.startPosition).toBe(0);
  expect(occ.endPosition).toBe(2); // 'pewno' sits at position 2 (space at 1)
  expect(occ.sentenceIndex).toBe(0);
});

test("no headwords: zero MWE occurrences, pipeline unchanged", () => {
  const db = freshDb();
  const res = persistAnalysis(db, { content: "x" }, ANALYSIS, new Date(), new Map());
  expect(res.mweCount).toBe(0);
  expect(db.select().from(schema.mweOccurrence).all()).toHaveLength(0);
});

test("names link to a base-form lemma without knowledge; common words and emoji are classified", () => {
  const db = freshDb();
  dict(db, [
    ["Kasia", "name"],
    ["bułka", "noun"],
    ["Róża", "name"],
    ["róża", "noun"],
  ]);
  const analysis: AnalyzeResponse = {
    sentences: [
      {
        tokens: [
          w("Bułka", "Bułka", "PROPN", ["Case=Nom"]),
          sp(" "),
          w("Marco", "marco", "PROPN"),
          sp(" "),
          w("Kasi", "Kasi", "PROPN", ["Case=Gen", "Number=Sing"]),
          sp(" "),
          w("Róża", "Róża", "PROPN"),
          sp(" "),
          w("🤗", "🤗", "PROPN"),
        ],
      },
    ],
  };
  persistAnalysis(db, { content: "x" }, analysis, new Date(), new Map());

  const lemmas = db.select().from(schema.lemma).all();
  const know = db.select().from(schema.knowledge).all();
  const tokens = db.select().from(schema.token).all();
  const lemmaOf = (surface: string) =>
    lemmas.find((l) => l.id === tokens.find((t) => t.surface === surface)?.lemmaId);

  for (const [surface, base] of [
    ["Marco", "Marco"],
    ["Kasi", "Kasia"],
    ["Róża", "Róża"],
  ]) {
    const l = lemmaOf(surface);
    expect(l).toMatchObject({ lemma: base, pos: "PROPN" });
    expect(know.filter((k) => k.lemmaId === l?.id)).toHaveLength(0);
  }
  const bulka = lemmaOf("Bułka");
  expect(bulka).toMatchObject({ lemma: "bułka", pos: "NOUN" });
  expect(know.filter((k) => k.lemmaId === bulka?.id).map((k) => k.track)).toEqual(["receptive"]);
  expect(tokens.find((t) => t.surface === "🤗")?.lemmaId).toBeNull();
  expect(tokens.find((t) => t.surface === "Kasi")?.tags).toEqual(["Case=Gen", "Number=Sing"]);
});

function entry(word: string, pos: string, forms: string[]) {
  return {
    word,
    pos,
    ipa: null,
    etymology: null,
    isMwe: false,
    senses: [],
    forms: forms.map((form) => ({ form, tags: [] })),
  };
}

function oneSentence(...tokens: ReturnType<typeof w>[]): AnalyzeResponse {
  return { sentences: [{ tokens }] };
}

function lemmaOf(db: ReturnType<typeof freshDb>, surface: string) {
  const tok = db
    .select()
    .from(schema.token)
    .all()
    .find((t) => t.surface === surface);
  return db
    .select()
    .from(schema.lemma)
    .all()
    .find((l) => l.id === tok?.lemmaId)?.lemma;
}

test("sidecar lemmas are corrected to the single dictionary headword for the surface and POS", () => {
  const db = freshDb();
  insertEntryBatch(db, [
    entry("pracować", "verb", ["pracujesz"]),
    entry("myśleć", "verb", ["myśli"]),
    entry("myśl", "noun", ["myśli"]),
    entry("słuchać", "verb", ["słucha"]),
    entry("słuch", "noun", ["słuchu"]),
  ]);
  persistAnalysis(
    db,
    { content: "x" },
    oneSentence(
      w("pracujesz", "pracujesz", "VERB"),
      w("Myśli", "myśli", "VERB"),
      w("słucha ", "słuch", "VERB"),
    ),
  );
  expect(lemmaOf(db, "pracujesz")).toBe("pracować");
  expect(lemmaOf(db, "Myśli")).toBe("myśleć");
  expect(lemmaOf(db, "słucha ")).toBe("słuchać");
});

test("an empty dictionary leaves sidecar lemmas unchanged", () => {
  const db = freshDb();
  persistAnalysis(db, { content: "x" }, oneSentence(w("słucha", "słuch", "VERB")));
  expect(lemmaOf(db, "słucha")).toBe("słuch");
});

test("a surface matching two headwords for the same POS keeps the sidecar lemma", () => {
  const db = freshDb();
  insertEntryBatch(db, [entry("mieć", "verb", ["mają"]), entry("majać", "verb", ["mają"])]);
  persistAnalysis(db, { content: "x" }, oneSentence(w("mają", "mają", "VERB")));
  expect(lemmaOf(db, "mają")).toBe("mają");
});

test("a sidecar lemma that is a headword for its POS is never replaced", () => {
  const db = freshDb();
  insertEntryBatch(db, [entry("robić", "verb", []), entry("robieć", "verb", ["robię"])]);
  persistAnalysis(db, { content: "x" }, oneSentence(w("robię", "robić", "VERB")));
  expect(lemmaOf(db, "robię")).toBe("robić");
});

test("MWE detection sees the corrected lemma", () => {
  const db = freshDb();
  insertEntryBatch(db, [entry("słuchać", "verb", ["słucha"])]);
  const res = persistAnalysis(
    db,
    { content: "x" },
    oneSentence(w("słucha", "słuch", "VERB"), sp(" "), w("muzyki", "muzyka", "NOUN")),
    new Date(),
    new Map([["słuchać", ["słuchać muzyki"]]]),
  );
  expect(res.mweCount).toBe(1);
});

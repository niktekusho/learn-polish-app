import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import { persistAnalysis } from "#/import/pipeline";
import type { AnalyzeResponse } from "#/import/sidecar";
import { initialKnowledgeFields } from "#/fsrs/index";
import {
  backfillTokenTags,
  clearSourceTexts,
  getStats,
  pruneOrphanLemmas,
  purgeStubGlosses,
  relinkDerivedWords,
  repairLemmaSlips,
  repairNames,
  proofreadEpisodes,
} from "./ops";

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

const ANALYSIS: AnalyzeResponse = {
  sentences: [{ tokens: [w("Robię", "robić", "VERB"), w("obiad", "obiad", "NOUN")] }],
};

test("clearing texts keeps glossed and reviewed lemmas; prune drops the rest", () => {
  const db = freshDb();
  persistAnalysis(db, { content: "Robię obiad" }, ANALYSIS);

  // "robić" is translated (real provider), "obiad" also stub-glossed elsewhere.
  const robic = db
    .select()
    .from(schema.lemma)
    .all()
    .find((l) => l.lemma === "robić")!;
  db.insert(schema.gloss)
    .values({ lemmaId: robic.id, italian: "fare", provider: "claude-cli" })
    .run();

  expect(clearSourceTexts(db)).toBe(1);
  expect(db.select().from(schema.token).all()).toHaveLength(0);
  // Both lemmas + knowledge survive the text wipe.
  expect(db.select().from(schema.lemma).all()).toHaveLength(2);
  expect(db.select().from(schema.knowledge).all()).toHaveLength(2);
  expect(db.select().from(schema.gloss).all()).toHaveLength(1);

  // Prune drops only "obiad" (no gloss, no reviews); "robić" keeps its gloss.
  expect(pruneOrphanLemmas(db)).toBe(1);
  const left = db.select().from(schema.lemma).all();
  expect(left.map((l) => l.lemma)).toEqual(["robić"]);
  expect(db.select().from(schema.knowledge).all()).toHaveLength(1);
});

test("prune keeps unglossed MWE lemmas that have occurrences", () => {
  const db = freshDb();
  const analysis: AnalyzeResponse = {
    sentences: [{ tokens: [w("na", "na", "ADP"), w("pewno", "pewno", "ADV")] }],
  };
  persistAnalysis(
    db,
    { content: "na pewno" },
    analysis,
    new Date(),
    new Map([["na", ["na pewno"]]]),
  );
  const mwe = db
    .select()
    .from(schema.lemma)
    .all()
    .find((l) => l.pos === "MWE")!;

  // MWE has no token rows, no gloss, no reviews — but an occurrence: kept.
  pruneOrphanLemmas(db);
  expect(
    db
      .select()
      .from(schema.lemma)
      .all()
      .find((l) => l.id === mwe.id),
  ).toBeDefined();

  // Once its text (and occurrence) is gone, prune sweeps it like any orphan.
  clearSourceTexts(db);
  pruneOrphanLemmas(db);
  expect(
    db
      .select()
      .from(schema.lemma)
      .all()
      .find((l) => l.id === mwe.id),
  ).toBeUndefined();
});

test("purgeStubGlosses removes only stub rows", () => {
  const db = freshDb();
  persistAnalysis(db, { content: "Robię obiad" }, ANALYSIS);
  const [a, b] = db.select().from(schema.lemma).all();
  db.insert(schema.gloss).values({ lemmaId: a.id, italian: "x", provider: "stub" }).run();
  db.insert(schema.gloss).values({ lemmaId: b.id, italian: "y", provider: "claude-cli" }).run();

  expect(purgeStubGlosses(db)).toBe(1);
  expect(getStats(db).glosses).toBe(1);
  expect(getStats(db).stubGlosses).toBe(0);
});

test("repairNames cleans PROPN lemmas imported as vocabulary, and is idempotent", () => {
  const db = freshDb();
  db.insert(schema.dictEntry)
    .values([
      { word: "Kasia", pos: "name" },
      { word: "Hanna", pos: "name" },
      { word: "bułka", pos: "noun" },
      { word: "masło", pos: "noun" },
    ])
    .run();
  const [{ id: textId }] = db
    .insert(schema.sourceText)
    .values({ content: "x" })
    .returning({ id: schema.sourceText.id })
    .all();
  const seeded = [
    ["Marco", "PROPN"],
    ["marco", "PROPN"],
    ["Kasia", "PROPN"],
    ["kasia", "PROPN"],
    ["Kasi", "PROPN"],
    ["Hanna", "PROPN"],
    ["Hanno", "PROPN"],
    ["Bułka", "PROPN"],
    ["bułka", "NOUN"],
    ["Masło", "PROPN"],
    ["🤗", "PROPN"],
    ["Dzię", "PROPN"],
  ];
  seeded.forEach(([word, pos], position) => {
    const [{ id }] = db
      .insert(schema.lemma)
      .values({ lemma: word, pos })
      .returning({ id: schema.lemma.id })
      .all();
    db.insert(schema.token)
      .values({ textId, lemmaId: id, surface: word, position, sentenceIndex: 0 })
      .run();
    db.insert(schema.knowledge)
      .values({ lemmaId: id, track: "receptive", ...initialKnowledgeFields(new Date()) })
      .run();
    db.insert(schema.gloss).values({ lemmaId: id, italian: "x" }).run();
    db.insert(schema.reviewLog)
      .values({ lemmaId: id, track: "receptive", rating: 3, stateBefore: 0, stateAfter: 1 })
      .run();
  });

  repairNames(db);

  const lemmas = db.select().from(schema.lemma).all();
  const byId = new Map(lemmas.map((l) => [l.id, l]));
  const lemmaOf = (surface: string) =>
    byId.get(
      db
        .select()
        .from(schema.token)
        .all()
        .find((t) => t.surface === surface)?.lemmaId ?? -1,
    );
  expect(lemmas.map((l) => `${l.lemma}/${l.pos}`).sort()).toEqual([
    "Hanna/PROPN",
    "Kasia/PROPN",
    "Marco/PROPN",
    "bułka/NOUN",
    "masło/NOUN",
  ]);
  expect(lemmaOf("marco")?.lemma).toBe("Marco");
  expect(lemmaOf("kasia")?.lemma).toBe("Kasia");
  expect(lemmaOf("Kasi")?.lemma).toBe("Kasia");
  expect(lemmaOf("Hanno")?.lemma).toBe("Hanna");
  expect(lemmaOf("Bułka")).toMatchObject({ lemma: "bułka", pos: "NOUN" });
  expect(lemmaOf("Masło")).toMatchObject({ lemma: "masło", pos: "NOUN" });
  expect(lemmaOf("🤗")).toBeUndefined();
  expect(lemmaOf("Dzię")).toBeUndefined();

  const names = new Set(lemmas.filter((l) => l.pos === "PROPN").map((l) => l.id));
  for (const t of [schema.knowledge, schema.gloss, schema.reviewLog]) {
    const rows = db.select({ lemmaId: t.lemmaId }).from(t).all();
    expect(rows.filter((r) => names.has(r.lemmaId))).toHaveLength(0);
  }
  // bułka keeps its own rows; Masło was converted in place with its knowledge.
  const known = db.select().from(schema.knowledge).all();
  expect(known.map((k) => byId.get(k.lemmaId)?.lemma).sort()).toEqual(["bułka", "masło"]);

  expect(repairNames(db)).toEqual({ deleted: 0, commonWords: 0, merged: 0, cleared: 0 });
});

const TAGGED: AnalyzeResponse = {
  sentences: [
    {
      tokens: [
        {
          surface: "Dziękuje",
          lemma: "dziękować",
          pos: "VERB",
          tags: ["Person=3"],
          is_space: false,
        },
        { surface: " ", lemma: " ", pos: "SPACE", tags: [], is_space: true },
        { surface: "Kasi", lemma: "Kasia", pos: "PROPN", tags: ["Case=Dat"], is_space: false },
      ],
    },
  ],
};

function untaggedText(db: ReturnType<typeof freshDb>) {
  persistAnalysis(db, { content: "Dziękuje Kasi" }, TAGGED, new Date(), new Map());
  db.update(schema.token).set({ tags: null }).run();
}
const tagsOf = (db: ReturnType<typeof freshDb>) =>
  db
    .select()
    .from(schema.token)
    .all()
    .map((t) => t.tags);

test("backfillTokenTags copies tags by position when the re-analysis matches", async () => {
  const db = freshDb();
  untaggedText(db);
  expect(await backfillTokenTags(db, async () => TAGGED)).toEqual({
    filled: 1,
    skipped: 0,
    failed: 0,
  });
  expect(tagsOf(db)).toEqual([["Person=3"], [], ["Case=Dat"]]);
  const never = async (): Promise<AnalyzeResponse> => {
    throw new Error("must not re-analyze a tagged text");
  };
  expect(await backfillTokenTags(db, never)).toEqual({ filled: 0, skipped: 0, failed: 0 });
});

test("backfillTokenTags skips a text whose re-analysis has different tokens", async () => {
  const db = freshDb();
  untaggedText(db);
  const other = { sentences: [{ tokens: TAGGED.sentences[0].tokens.slice(0, 2) }] };
  expect(await backfillTokenTags(db, async () => other)).toEqual({
    filled: 0,
    skipped: 1,
    failed: 0,
  });
  expect(tagsOf(db)).toEqual([null, null, null]);
});

test("backfillTokenTags counts an unreachable sidecar as failed and writes nothing", async () => {
  const db = freshDb();
  untaggedText(db);
  const down = async (): Promise<AnalyzeResponse> => {
    throw new TypeError("fetch failed");
  };
  expect(await backfillTokenTags(db, down)).toEqual({ filled: 0, skipped: 0, failed: 1 });
  expect(tagsOf(db)).toEqual([null, null, null]);
});

type DB = ReturnType<typeof freshDb>;

const LEMMAS: Record<string, [string, string]> = {
  duża: ["duży", "ADJ"],
  duży: ["duży", "ADJ"],
  torta: ["torta", "NOUN"],
  tortę: ["tortę", "NOUN"],
  tort: ["tort", "NOUN"],
  jest: ["być", "AUX"],
  gotowa: ["gotowy", "ADJ"],
  gotowy: ["gotowy", "ADJ"],
  pani: ["pani", "NOUN"],
  hanna: ["Hanna", "PROPN"],
  kroi: ["kroić", "VERB"],
  i: ["i", "CCONJ"],
  ciasto: ["ciasto", "NOUN"],
  kotta: ["kotta", "NOUN"],
  śpi: ["spać", "VERB"],
};

// Sentences end in "."; words are looked up in LEMMAS.
async function analyzeStory(text: string): Promise<AnalyzeResponse> {
  return {
    sentences: text.split(/(?<=\.) /).map((sentence, s, sentences) => ({
      tokens: sentence.split(/(?=\.)| /).flatMap((word, i, all) => {
        if (word === ".") return [w(s < sentences.length - 1 ? ". " : ".", ".", "PUNCT")];
        const [lemma, pos] = LEMMAS[word.toLowerCase()];
        const ws = all[i + 1] === "." ? "" : " ";
        return [w(word + ws, lemma, pos)];
      }),
    })),
  };
}

// The episode 6 sentences, as the model wrote and as a Correction fixes them.
const EP6 = "Duża torta jest gotowa. Pani Hanna kroi tortę i ciasto.";
const EP6_FIXED = "Duży tort jest gotowy. Pani Hanna kroi tort.";

function seedHomeDictionary(db: DB) {
  insertDict(db, [
    ["duży", "adj", ["duży", "duża"]],
    ["tort", "noun", ["tort", "tortu"]],
    ["być", "verb", ["jest"]],
    ["gotowy", "adj", ["gotowy", "gotowa"]],
    ["pani", "noun", ["pani"]],
    ["Hanna", "name", ["Hanna"]],
    ["kroić", "verb", ["kroi"]],
    ["i", "conj", ["i"]],
    ["ciasto", "noun", ["ciasto"]],
    ["spać", "verb", ["śpi"]],
  ]);
}

function insertDict(db: DB, entries: [string, string, (string | [string, string[]])[]][]) {
  for (const [word, pos, forms] of entries) {
    const [{ id }] = db
      .insert(schema.dictEntry)
      .values({ word, pos })
      .returning({ id: schema.dictEntry.id })
      .all();
    for (const f of forms) {
      const [form, tags] = typeof f === "string" ? [f, []] : f;
      db.insert(schema.dictForm).values({ entryId: id, form, tags }).run();
    }
  }
}

async function seedEpisode(
  db: DB,
  episodeNumber: number,
  content: string,
  readAt: Date | null,
  analysis?: AnalyzeResponse,
) {
  const [s] = db.select().from(schema.story).all();
  const storyId =
    s?.id ??
    db
      .insert(schema.story)
      .values({
        title: "La panetteria di Pani Hanna",
        genre: "quotidiano",
        hook: "h",
        outline: { plot: "p", characters: [], beats: ["b"] },
        plannedEpisodes: 10,
        status: "active",
      })
      .returning({ id: schema.story.id })
      .all()[0].id;
  const { textId } = persistAnalysis(
    db,
    { title: `La panetteria · episodio ${episodeNumber}`, content, storyId, episodeNumber },
    analysis ?? (await analyzeStory(content)),
    new Date(),
    new Map(),
  );
  db.update(schema.sourceText).set({ readAt }).where(eq(schema.sourceText.id, textId)).run();
  return textId;
}

const lemmaRow = (db: DB, word: string) =>
  db
    .select()
    .from(schema.lemma)
    .all()
    .find((l) => l.lemma === word);

function practise(db: DB, word: string) {
  const id = lemmaRow(db, word)!.id;
  db.insert(schema.reviewLog)
    .values({ lemmaId: id, track: "receptive", rating: 3, stateBefore: 0, stateAfter: 1 })
    .run();
  db.insert(schema.gloss)
    .values({ lemmaId: id, italian: "torta (dolce)", provider: "claude-cli" })
    .run();
  return id;
}

const proofreader = {
  name: "stub" as const,
  async proofread() {
    return [];
  },
  async correct(text: string) {
    return text === EP6 ? EP6_FIXED : text;
  },
};

function repairDeps() {
  return {
    provider: proofreader,
    analyze: analyzeStory,
    checker: proofreader,
    mweHeadwords: new Map(),
  };
}

test("repair replaces a flagged episode's content and tokens in place", async () => {
  const db = freshDb();
  seedHomeDictionary(db);
  const readAt = new Date("2026-10-20T10:00:00Z");
  const textId = await seedEpisode(db, 6, EP6, readAt);
  db.insert(schema.passageQuestion)
    .values({
      lemmaId: lemmaRow(db, "ciasto")!.id,
      passage: "Duża torta jest gotowa.",
      target: "ciasto",
      source: "text",
      textId,
      question: "?",
      choices: ["a", "b", "c"],
      correctIndex: 0,
      provider: "stub",
    })
    .run();

  const report = await proofreadEpisodes(db, repairDeps());

  expect(report.failed).toEqual([]);
  expect(report.repaired).toEqual([
    {
      textId,
      label: "La panetteria · episodio 6",
      changes: [
        '"Duża torta jest gotowa." → "Duży tort jest gotowy."',
        '"tortę i ciasto." → "tort."',
      ],
    },
  ]);
  const [text] = db.select().from(schema.sourceText).all();
  expect(text).toMatchObject({ id: textId, content: EP6_FIXED, readAt, episodeNumber: 6 });
  const tokens = db.select().from(schema.token).all();
  expect(tokens.map((t) => t.surface).join("")).toBe(EP6_FIXED);
  expect(db.select().from(schema.passageQuestion).all()).toEqual([]);
});

test("repair deletes out-of-dictionary lemmas left without tokens, and keeps dictionary ones", async () => {
  const db = freshDb();
  seedHomeDictionary(db);
  await seedEpisode(db, 6, EP6, new Date());
  const torta = practise(db, "torta");
  const ciasto = practise(db, "ciasto");

  const report = await proofreadEpisodes(db, repairDeps());

  expect(report.deletedLemmas).toBe(2);
  expect(lemmaRow(db, "torta")).toBeUndefined();
  expect(lemmaRow(db, "tortę")).toBeUndefined();
  for (const t of [schema.knowledge, schema.reviewLog, schema.gloss]) {
    expect(db.select().from(t).where(eq(t.lemmaId, torta)).all()).toEqual([]);
  }
  const tort = lemmaRow(db, "tort")!;
  expect(
    db.select().from(schema.token).where(eq(schema.token.lemmaId, tort.id)).all(),
  ).toHaveLength(2);
  expect(lemmaRow(db, "ciasto")).toBeDefined();
  expect(
    db.select().from(schema.knowledge).where(eq(schema.knowledge.lemmaId, ciasto)).all(),
  ).toHaveLength(1);
  expect(
    db.select().from(schema.reviewLog).where(eq(schema.reviewLog.lemmaId, ciasto)).all(),
  ).toHaveLength(1);
});

test("repair keeps an analyzer slip whose word is still in the text", async () => {
  const db = freshDb();
  // Imported before the dictionary, the analyzer's non-headword "kroi" stayed uncorrected.
  const slipped = await analyzeStory(EP6);
  for (const t of slipped.sentences[1].tokens) if (t.surface === "kroi ") t.lemma = "kroi";
  await seedEpisode(db, 6, EP6, new Date(), slipped);
  seedHomeDictionary(db);
  const kroi = practise(db, "kroi");

  await proofreadEpisodes(db, repairDeps());

  expect(lemmaRow(db, "kroi")).toBeDefined();
  expect(
    db.select().from(schema.reviewLog).where(eq(schema.reviewLog.lemmaId, kroi)).all(),
  ).toHaveLength(1);
});

test("repair refuses to run without a home dictionary", async () => {
  const db = freshDb();
  await seedEpisode(db, 6, EP6, new Date());
  await expect(proofreadEpisodes(db, repairDeps())).rejects.toThrow(/home dictionary/);
  expect(db.select().from(schema.sourceText).all()[0].content).toBe(EP6);
});

test("a text failing the repair stays unchanged while the others are corrected", async () => {
  const db = freshDb();
  seedHomeDictionary(db);
  const ep6 = await seedEpisode(db, 6, EP6, new Date());
  const ep7 = await seedEpisode(db, 7, "Kotta śpi.", null);
  await seedEpisode(db, 8, "Pani Hanna śpi.", null);
  const ep7Tokens = db.select().from(schema.token).where(eq(schema.token.textId, ep7)).all();

  const report = await proofreadEpisodes(db, repairDeps());

  expect(report.repaired.map((r) => r.textId)).toEqual([ep6]);
  expect(report.failed).toEqual([
    {
      textId: ep7,
      label: "La panetteria · episodio 7",
      cause: expect.stringMatching(/"stub".*«Kotta»: not in the home dictionary/),
    },
  ]);
  const [text7] = db.select().from(schema.sourceText).where(eq(schema.sourceText.id, ep7)).all();
  expect(text7.content).toBe("Kotta śpi.");
  expect(db.select().from(schema.token).where(eq(schema.token.textId, ep7)).all()).toEqual(
    ep7Tokens,
  );
});

function importWords(db: DB, ...tokens: ReturnType<typeof w>[]) {
  return persistAnalysis(db, { content: "x" }, { sentences: [{ tokens }] }).textId;
}

const tokensOf = (db: DB, lemmaId: number) =>
  db.select().from(schema.token).where(eq(schema.token.lemmaId, lemmaId)).all();

test("a slip moves to its twin and is deleted with its own data; the twin keeps its state", () => {
  const db = freshDb();
  importWords(db, w("myśli", "myśli", "VERB"), w("Myśli", "myśli", "VERB"));
  importWords(db, w("myśleć", "myśleć", "VERB"));
  const slip = practise(db, "myśli");
  db.insert(schema.gloss)
    .values({ lemmaId: slip, sense: "s", italian: "pensa", provider: "manual" })
    .run();
  const [slipToken] = tokensOf(db, slip);
  db.insert(schema.occurrenceGloss)
    .values({ tokenId: slipToken.id, lemmaId: slip, italian: "pensa", provider: "claude-cli" })
    .run();
  const twin = lemmaRow(db, "myśleć")!.id;
  db.update(schema.knowledge)
    .set({ reps: 4, state: 2 })
    .where(eq(schema.knowledge.lemmaId, twin))
    .run();
  const twinKnowledge = db
    .select()
    .from(schema.knowledge)
    .where(eq(schema.knowledge.lemmaId, twin))
    .all();
  insertDict(db, [
    ["myśleć", "verb", ["myśli"]],
    ["myśl", "noun", ["myśli"]],
  ]);

  expect(repairLemmaSlips(db)).toEqual([{ slip: "myśli", target: "myśleć" }]);

  expect(lemmaRow(db, "myśli")).toBeUndefined();
  expect(tokensOf(db, twin).map((t) => t.surface)).toEqual(["myśli", "Myśli", "myśleć"]);
  for (const t of [schema.knowledge, schema.reviewLog, schema.gloss]) {
    expect(db.select().from(t).where(eq(t.lemmaId, slip)).all()).toEqual([]);
  }
  expect(
    db.select().from(schema.knowledge).where(eq(schema.knowledge.lemmaId, twin)).all(),
  ).toEqual(twinKnowledge);
  expect(db.select().from(schema.occurrenceGloss).all()).toMatchObject([
    { tokenId: slipToken.id, lemmaId: twin },
  ]);
  expect(db.select().from(schema.lemmaSlipRepair).all()).toMatchObject([
    { slip: "myśli", target: "myśleć", seenAt: null },
  ]);
});

test("a slip whose twin does not exist creates it as New", () => {
  const db = freshDb();
  importWords(db, w("pieczywa", "pieczywać", "VERB"));
  insertDict(db, [["pieczywo", "noun", ["pieczywo", "pieczywa"]]]);

  expect(repairLemmaSlips(db)).toEqual([{ slip: "pieczywać", target: "pieczywo" }]);

  const target = db.select().from(schema.lemma).all();
  expect(target).toMatchObject([{ lemma: "pieczywo", pos: "NOUN" }]);
  expect(tokensOf(db, target[0].id)).toHaveLength(1);
  expect(db.select().from(schema.knowledge).all()).toMatchObject([
    { lemmaId: target[0].id, track: "receptive", state: 0, reps: 0 },
  ]);
});

test("a slip whose surfaces fit two headwords, or none, is untouched", () => {
  const db = freshDb();
  importWords(
    db,
    w("mają", "mają", "VERB"),
    w("torta", "torta", "NOUN"),
    w("tortę", "torta", "NOUN"),
  );
  insertDict(db, [
    ["mieć", "verb", ["mają"]],
    ["majać", "verb", ["mają"]],
    ["tort", "noun", ["tort", "torta"]],
  ]);
  const before = db.select().from(schema.lemma).all();

  expect(repairLemmaSlips(db)).toEqual([]);
  expect(db.select().from(schema.lemma).all()).toEqual(before);
});

test("headword lemmas, MWEs and Names are never candidates", () => {
  const db = freshDb();
  importWords(db, w("robię", "robić", "VERB"), w("Kasi", "Kasia", "PROPN"));
  const mwe = db
    .insert(schema.lemma)
    .values({ lemma: "na pewno", pos: "MWE" })
    .returning()
    .all()[0];
  db.update(schema.token).set({ lemmaId: mwe.id }).where(eq(schema.token.surface, "robię")).run();
  importWords(db, w("robię", "robić", "VERB"));
  insertDict(db, [
    ["robić", "verb", []],
    ["robieć", "verb", ["robię"]],
    ["kasa", "noun", ["kasi"]],
    ["pewno", "adv", ["robię"]],
  ]);
  const before = db.select().from(schema.lemma).all();

  expect(repairLemmaSlips(db)).toEqual([]);
  expect(db.select().from(schema.lemma).all()).toEqual(before);
});

test("the sweep does nothing without a home dictionary", () => {
  const db = freshDb();
  importWords(db, w("pracujesz", "pracujesz", "VERB"));
  expect(repairLemmaSlips(db)).toEqual([]);
  expect(lemmaRow(db, "pracujesz")).toBeDefined();
});

test("tokens of a derived word move from its base to their own lemma; inflections stay", () => {
  const db = freshDb();
  insertDict(db, [
    ["pan", "noun", ["pan", ["pani", ["feminine"]], ["pana", ["genitive", "singular"]]]],
    ["on", "pron", [["ona", ["feminine", "nominative", "singular"]]]],
  ]);
  importWords(db, w("Pani", "pani", "NOUN"), w("pana", "pan", "NOUN"), w("ona", "on", "PRON"));
  const pan = lemmaRow(db, "pan")!.id;
  const [paniToken] = tokensOf(db, pan).filter((t) => t.surface === "Pani");
  db.insert(schema.occurrenceGloss)
    .values({ tokenId: paniToken.id, lemmaId: pan, italian: "signora", provider: "claude-cli" })
    .run();
  db.update(schema.knowledge).set({ reps: 4 }).where(eq(schema.knowledge.lemmaId, pan)).run();
  insertDict(db, [
    ["pani", "noun", ["pani"]],
    ["ona", "pron", ["ona"]],
  ]);

  expect(relinkDerivedWords(db)).toBe(1);

  const pani = lemmaRow(db, "pani")!;
  expect(pani.pos).toBe("NOUN");
  expect(tokensOf(db, pani.id).map((t) => t.surface)).toEqual(["Pani"]);
  expect(tokensOf(db, pan).map((t) => t.surface)).toEqual(["pana"]);
  expect(tokensOf(db, lemmaRow(db, "on")!.id).map((t) => t.surface)).toEqual(["ona"]);
  expect(db.select().from(schema.occurrenceGloss).all()).toMatchObject([{ lemmaId: pani.id }]);
  expect(db.select().from(schema.knowledge).all()).toMatchObject([
    { lemmaId: pan, reps: 4 },
    { lemmaId: lemmaRow(db, "on")!.id, reps: 0 },
    { lemmaId: pani.id, state: 0, reps: 0 },
  ]);
  expect(relinkDerivedWords(db)).toBe(0);
});

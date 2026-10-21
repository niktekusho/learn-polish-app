import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
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
  repairNames,
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

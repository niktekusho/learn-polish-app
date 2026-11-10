import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import { insertEntryBatch } from "#/dictionary/loader";
import { importAnalysis } from "#/import/checked-import";
import { persistAnalysis } from "#/import/pipeline";
import type { AnalyzeResponse } from "#/import/sidecar";
import { callsNamed, fakeLlm } from "#/llm/fake";
import type { MweCheckItem } from "#/dictionary/llm";
import { repairCharacterNames } from "#/maintenance/ops";

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

function entry(word: string, pos: string, forms: string[] = []) {
  return {
    word,
    pos,
    ipa: null,
    etymology: null,
    isMwe: false,
    senses: [{ gloss: word, rawGloss: null, tags: [] }],
    forms: forms.map((form) => ({ form, tags: [] })),
  };
}

function seedStory(db: DB): number {
  insertEntryBatch(db, [
    entry("iskra", "noun", ["iskra", "iskry", "iskrę", "iskro"]),
    entry("Zosia", "name"),
    entry("widzieć", "verb"),
  ]);
  return db
    .insert(schema.story)
    .values({
      title: "Il drago",
      genre: "fiaba",
      hook: "",
      outline: {
        plot: "",
        characters: ["Iskra – piccolo drago verde", "Zosia – bambina gentile"],
        beats: ["episodio 1: arrivo"],
      },
      plannedEpisodes: 1,
      status: "active",
      createdAt: new Date(),
    })
    .returning({ id: schema.story.id })
    .all()[0].id;
}

/** Accepts a candidate unless its sentence speaks of fire ("pieca"). */
function fakeChecker() {
  return fakeLlm({
    answers: {
      "mwe-check": (items: MweCheckItem[]) => items.map((i) => !i.sentence.includes("pieca")),
    },
  });
}

/** The items of each mwe-check call, in call order. */
const checks = (llm: ReturnType<typeof fakeLlm>) =>
  callsNamed(llm, "mwe-check").map((c) => c.req as MweCheckItem[]);

function lemmaOf(db: DB, surface: string) {
  return db
    .select({ lemma: schema.lemma.lemma, pos: schema.lemma.pos })
    .from(schema.token)
    .innerJoin(schema.lemma, eq(schema.token.lemmaId, schema.lemma.id))
    .where(eq(schema.token.surface, surface))
    .all();
}

function importEpisode(
  db: DB,
  storyId: number,
  analysis: AnalyzeResponse,
  checker = fakeChecker(),
) {
  return importAnalysis(
    db,
    checker,
    { content: "x", storyId, episodeNumber: 1 },
    analysis,
    new Map(),
  );
}

test("a capitalized character name mid-sentence is that Name, even when it is a common word", async () => {
  const db = freshDb();
  const storyId = seedStory(db);
  const checker = fakeChecker();
  await importEpisode(
    db,
    storyId,
    {
      sentences: [
        {
          tokens: [
            w("Zosia ", "Zosia", "PROPN"),
            w("widzi ", "widzieć", "VERB"),
            w("Iskrę ", "iskra", "NOUN"),
            w("i ", "i", "CCONJ"),
            w("iskry", "iskra", "NOUN"),
          ],
        },
      ],
    },
    checker,
  );

  expect(lemmaOf(db, "Iskrę ")).toEqual([{ lemma: "Iskra", pos: "PROPN" }]);
  expect(lemmaOf(db, "iskry")).toEqual([{ lemma: "iskra", pos: "NOUN" }]);
  expect(checks(checker)).toHaveLength(0);
});

test("a character name at sentence start that is also a common word is checked in its sentence", async () => {
  const db = freshDb();
  const storyId = seedStory(db);
  const checker = fakeChecker();
  await importEpisode(
    db,
    storyId,
    {
      sentences: [
        { tokens: [w("Iskra ", "iskra", "NOUN"), w("widzi", "widzieć", "VERB")] },
        { tokens: [w("Iskry ", "iskra", "NOUN"), w("z ", "z", "ADP"), w("pieca", "piec", "NOUN")] },
        { tokens: [w("Zosia ", "Zosia", "PROPN"), w("widzi", "widzieć", "VERB")] },
      ],
    },
    checker,
  );

  expect(lemmaOf(db, "Iskra ")).toEqual([{ lemma: "Iskra", pos: "PROPN" }]);
  expect(lemmaOf(db, "Iskry ")).toEqual([{ lemma: "iskra", pos: "NOUN" }]);
  expect(lemmaOf(db, "Zosia ")).toEqual([{ lemma: "Zosia", pos: "PROPN" }]);
  expect(
    checks(checker)
      .flat()
      .map((i) => i.headword),
  ).toEqual(["Iskra", "Iskra"]);
  expect(checks(checker)[0][0].meaning).toContain("piccolo drago verde");
});

test("repair moves stored Episode occurrences to the character and deletes the emptied word", async () => {
  const db = freshDb();
  const storyId = seedStory(db);
  // Imported before the character rule: the dragon is the noun, its vocative a Name of its own.
  persistAnalysis(
    db,
    { content: "x", storyId, episodeNumber: 1 },
    {
      sentences: [
        {
          tokens: [
            w("Zosia ", "Zosia", "PROPN"),
            w("widzi ", "widzieć", "VERB"),
            w("Iskrę", "iskra", "NOUN"),
          ],
        },
        { tokens: [w("– ", "–", "PUNCT"), w("Iskro", "Iskro", "PROPN"), w("!", "!", "PUNCT")] },
      ],
    },
    new Date(),
    new Map(),
  );
  persistAnalysis(
    db,
    { content: "y" },
    { sentences: [{ tokens: [w("Iskrę ", "iskra", "NOUN"), w("widzi", "widzieć", "VERB")] }] },
    new Date(),
    new Map(),
  );

  expect(await repairCharacterNames(db, fakeChecker())).toEqual({ moved: 2, deletedLemmas: 1 });
  expect(lemmaOf(db, "Iskrę")).toEqual([{ lemma: "Iskra", pos: "PROPN" }]);
  expect(lemmaOf(db, "Iskro")).toEqual([{ lemma: "Iskra", pos: "PROPN" }]);
  // A text outside the Story keeps the word.
  expect(lemmaOf(db, "Iskrę ")).toEqual([{ lemma: "iskra", pos: "NOUN" }]);
  expect(await repairCharacterNames(db, fakeChecker())).toEqual({ moved: 0, deletedLemmas: 0 });
});

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import { initialKnowledgeFields } from "#/fsrs/index";
import { persistAnalysis } from "#/import/pipeline";
import type { AnalyzeResponse } from "#/import/sidecar";
import type { GlossProvider, PassageQuestionRequest } from "#/llm/provider";
import { passagePrepTargets, preparePassages } from "./service";

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  return db;
}
type DB = ReturnType<typeof freshDb>;

// Sentences of space-separated words; every word is a NOUN lemmatized to itself.
function importText(
  db: DB,
  sentences: string[],
  extra: { storyId?: number; episodeNumber?: number } = {},
) {
  const analysis: AnalyzeResponse = {
    sentences: sentences.map((s, i) => ({
      tokens: [
        ...(i ? [{ surface: " ", lemma: " ", pos: "SPACE", tags: [], is_space: true }] : []),
        ...s
          .split(" ")
          .flatMap((w, j) => [
            ...(j ? [{ surface: " ", lemma: " ", pos: "SPACE", tags: [], is_space: true }] : []),
            { surface: w, lemma: w.replace(/\.$/, ""), pos: "NOUN", tags: [], is_space: false },
          ]),
      ],
    })),
  };
  return persistAnalysis(
    db,
    { content: sentences.join(" "), ...extra },
    analysis,
    new Date(),
    new Map(),
  ).textId;
}

function lemmaId(db: DB, word: string) {
  const row = db
    .select()
    .from(schema.lemma)
    .all()
    .find((l) => l.lemma === word);
  if (row) return row.id;
  const [{ id }] = db
    .insert(schema.lemma)
    .values({ lemma: word, pos: "ADP" })
    .returning({ id: schema.lemma.id })
    .all();
  db.insert(schema.knowledge)
    .values({ lemmaId: id, track: "receptive", ...initialKnowledgeFields() })
    .run();
  return id;
}

function fakeProvider(opts: { junk?: boolean } = {}) {
  return {
    name: "stub" as const,
    calls: { passage: 0, question: 0 },
    questionRequests: [] as PassageQuestionRequest[],
    async gloss() {
      return "unused";
    },
    async passage(req: { lemma: string }) {
      this.calls.passage++;
      return { passage: `Idę ${req.lemma} domu.`, target: req.lemma };
    },
    async passageQuestion(req: PassageQuestionRequest) {
      this.calls.question++;
      this.questionRequests.push(req);
      if (opts.junk) throw new Error("passage question output is not JSON");
      return { question: "Dove?", choices: ["a casa", "al mare", "a scuola"], correctIndex: 0 };
    },
  } satisfies GlossProvider & {
    calls: Record<string, number>;
    questionRequests: PassageQuestionRequest[];
  };
}

test("a real passage is cut around the shortest sentence holding the lemma", async () => {
  const db = freshDb();
  const textId = importText(db, [
    "Ala ma kota.",
    "Idę do sklepu.",
    "Kot śpi.",
    "Potem idę do bardzo dużego i ładnego parku.",
  ]);
  const provider = fakeProvider();

  expect(await preparePassages(db, [lemmaId(db, "do")], provider)).toBe(1);
  expect(provider.calls).toEqual({ passage: 0, question: 1 });
  expect(provider.questionRequests[0]).toMatchObject({
    passage: "Ala ma kota. Idę do sklepu. Kot śpi.",
    lemma: "do",
    target: "do",
  });
  const [row] = db.select().from(schema.passageQuestion).all();
  expect(row).toMatchObject({ source: "text", textId, choices: ["a casa", "al mare", "a scuola"] });
});

test("without a read sentence the passage is generated", async () => {
  const db = freshDb();
  // An unread episode is not "read text": its sentences stay out.
  const [{ id: storyId }] = db
    .insert(schema.story)
    .values({
      title: "t",
      genre: "g",
      hook: "h",
      outline: { plot: "p", characters: [], beats: ["b"] },
      plannedEpisodes: 1,
      status: "active",
    })
    .returning({ id: schema.story.id })
    .all();
  importText(db, ["Idę za domem."], { storyId, episodeNumber: 1 });
  const provider = fakeProvider();

  await preparePassages(db, [lemmaId(db, "za")], provider);
  expect(provider.calls).toEqual({ passage: 1, question: 1 });
  expect(db.select().from(schema.passageQuestion).all()).toMatchObject([
    { source: "generated", textId: null, passage: "Idę za domu.", target: "za" },
  ]);
});

test("a junk question response caches nothing; a prepared lemma is skipped", async () => {
  const db = freshDb();
  importText(db, ["Idę do sklepu."]);
  const id = lemmaId(db, "do");

  expect(await preparePassages(db, [id], fakeProvider({ junk: true }))).toBe(0);
  expect(db.select().from(schema.passageQuestion).all()).toHaveLength(0);

  await preparePassages(db, [id], fakeProvider());
  const again = fakeProvider();
  await preparePassages(db, [id], again);
  expect(again.calls).toEqual({ passage: 0, question: 0 });
  expect(db.select().from(schema.passageQuestion).all()).toHaveLength(1);
});

test("prep targets: receptive dues of the next 2 days without a passage, capped", async () => {
  const db = freshDb();
  const now = new Date("2026-10-14T12:00:00Z");
  const at = (days: number) => new Date(now.getTime() + days * 86_400_000);
  const ids = ["a", "b", "c", "d"].map((w) => lemmaId(db, w));
  const dues = [at(-1), at(1), at(3), at(0)];
  ids.forEach((id, i) =>
    db.update(schema.knowledge).set({ due: dues[i] }).where(eq(schema.knowledge.lemmaId, id)).run(),
  );
  await preparePassages(db, [ids[3]], fakeProvider()); // d already has one

  expect(passagePrepTargets(db, now)).toEqual([ids[0], ids[1]]);
  expect(passagePrepTargets(db, now, 1)).toEqual([ids[0]]);
});

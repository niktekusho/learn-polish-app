import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import { senseKey } from "#/dictionary/service";
import type { GlossProvider, ReportReviewItem, ReportVerdict } from "#/llm/provider";
import { StubProvider } from "#/llm/stub";
import { insertEntryBatch } from "#/dictionary/loader";
import { persistAnalysis } from "#/import/pipeline";
import {
  listReviews,
  pendingReports,
  reportLemma,
  reviewReports,
  takeCorrections,
  undoReview,
} from "./review";

type DB = ReturnType<typeof freshDb>;

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  return db;
}

/** A lemma with a primary gloss and, per English sense, a dictionary sense with its Italian. */
function seed(
  db: DB,
  word: string,
  opts: {
    gloss?: string;
    provider?: "claude-cli" | "manual";
    senses?: [string, string][];
    flagged?: string;
    contextBound?: boolean;
  },
) {
  const [{ id }] = db
    .insert(schema.lemma)
    .values({
      lemma: word,
      pos: "ADV",
      flaggedAt: opts.flagged === undefined ? null : new Date("2026-10-05"),
      flagNote: opts.flagged || null,
      contextBound: opts.contextBound ?? false,
    })
    .returning({ id: schema.lemma.id })
    .all();
  if (opts.gloss) {
    db.insert(schema.gloss)
      .values({
        lemmaId: id,
        sense: "",
        italian: opts.gloss,
        provider: opts.provider ?? "claude-cli",
      })
      .run();
  }
  if (opts.senses) {
    const [{ entryId }] = db
      .insert(schema.dictEntry)
      .values({ word, pos: "adv" })
      .returning({ entryId: schema.dictEntry.id })
      .all();
    opts.senses.forEach(([english, italian], senseIndex) => {
      db.insert(schema.dictSense).values({ entryId, senseIndex, gloss: english, tags: [] }).run();
      db.insert(schema.gloss)
        .values({ lemmaId: id, sense: senseKey(english), italian, provider: "claude-cli" })
        .run();
    });
  }
  return id;
}

function primary(db: DB, lemmaId: number) {
  return db
    .select()
    .from(schema.gloss)
    .where(and(eq(schema.gloss.lemmaId, lemmaId), eq(schema.gloss.sense, "")))
    .all()[0];
}

function lemmaRow(db: DB, id: number) {
  return db.select().from(schema.lemma).where(eq(schema.lemma.id, id)).all()[0];
}

function fake(verdicts: (ReportVerdict | null)[]): GlossProvider & { calls: ReportReviewItem[][] } {
  const calls: ReportReviewItem[][] = [];
  return {
    name: "claude-cli",
    calls,
    gloss: async () => "",
    reviewReports: async (items) => {
      calls.push(items);
      return verdicts;
    },
  };
}

test("one provider call reviews every wrong Report and applies each verdict", async () => {
  const db = freshDb();
  const tylko = seed(db, "tylko", { gloss: "ma anche", senses: [["only", "solo"]], flagged: "" });
  const tez = seed(db, "też", { gloss: "anche", senses: [["also", "anche"]], flagged: "?" });
  let calls = 0;
  const stub = new StubProvider();
  const counted: GlossProvider = {
    name: "stub",
    gloss: async () => "",
    reviewReports: (items) => {
      calls++;
      return stub.reviewReports(items);
    },
  };

  expect(await reviewReports(db, counted)).toBe(2);
  expect(calls).toBe(1);
  expect(primary(db, tylko)).toMatchObject({ italian: "solo", provider: "stub" });
  expect(primary(db, tez).italian).toBe("anche");
  expect(lemmaRow(db, tylko).flaggedAt).toBeNull();
  expect(pendingReports(db)).toHaveLength(0);
});

test("an unknown sense key leaves that lemma pending while the other applies", async () => {
  const db = freshDb();
  const a = seed(db, "tylko", { gloss: "ma anche", senses: [["only", "solo"]], flagged: "" });
  const b = seed(db, "swój", {
    gloss: "swoich → proprio",
    senses: [["one's own", "proprio"]],
    flagged: "",
  });
  const provider = fake([
    { gloss: { sense: 5 }, contextBound: false, names: [], reason: "x" },
    { gloss: { sense: 0 }, contextBound: false, names: [], reason: "Forma flessa nella glossa." },
  ]);

  expect(await reviewReports(db, provider)).toBe(1);
  expect(lemmaRow(db, a).flaggedAt).not.toBeNull();
  expect(primary(db, a).italian).toBe("ma anche");
  expect(primary(db, b).italian).toBe("proprio");
  expect(pendingReports(db).map((p) => p.lemma)).toEqual(["tylko"]);
});

test("free Italian is rejected when dictionary senses exist, unless no sense fits", async () => {
  const db = freshDb();
  const withSenses = seed(db, "tylko", {
    gloss: "ma anche",
    senses: [["only", "solo"]],
    flagged: "",
  });
  const reject = fake([
    {
      gloss: { italian: "soltanto", noSenseFits: false },
      contextBound: false,
      names: [],
      reason: "x",
    },
  ]);
  expect(await reviewReports(db, reject)).toBe(0);

  const accept = fake([
    {
      gloss: { italian: "soltanto", noSenseFits: true },
      contextBound: false,
      names: [],
      reason: "x",
    },
  ]);
  expect(await reviewReports(db, accept)).toBe(1);
  expect(primary(db, withSenses)).toMatchObject({ italian: "soltanto", provider: "claude-cli" });
});

test("a manual primary gloss is never replaced", async () => {
  const db = freshDb();
  const id = seed(db, "tylko", {
    gloss: "solo",
    provider: "manual",
    senses: [["only", "soltanto"]],
    flagged: "",
  });
  await reviewReports(
    db,
    fake([{ gloss: { sense: 0 }, contextBound: false, names: [], reason: "x" }]),
  );
  expect(primary(db, id)).toMatchObject({ italian: "solo", provider: "manual" });
});

test("a provider failure leaves every Report pending and out of practice", async () => {
  const db = freshDb();
  seed(db, "tylko", { gloss: "ma anche", flagged: "" });
  const failing: GlossProvider = {
    name: "claude-cli",
    gloss: async () => "",
    reviewReports: async () => {
      throw new Error("claude exited 1");
    },
  };
  await expect(reviewReports(db, failing)).rejects.toThrow("claude exited 1");
  expect(pendingReports(db)).toHaveLength(1);
  expect(db.select().from(schema.reportReview).all()).toHaveLength(0);
});

test("corrections are shown once; Maintenance lists every review", async () => {
  const db = freshDb();
  seed(db, "tylko", { gloss: "ma anche", senses: [["only", "solo, soltanto"]], flagged: "" });
  seed(db, "do", { gloss: "a", contextBound: true, flagged: "" });
  db.insert(schema.lemmaSlipRepair).values({ slip: "myśli", target: "myśleć" }).run();
  await reviewReports(
    db,
    fake([
      { gloss: { sense: 0 }, contextBound: false, names: [], reason: "x" },
      { gloss: "keep", contextBound: true, names: [], reason: "x" },
    ]),
  );

  expect(takeCorrections(db).map((c) => c.line)).toEqual([
    "do: invariata",
    'tylko: "ma anche" → "solo, soltanto"',
    "myśli → myśleć",
  ]);
  expect(takeCorrections(db)).toHaveLength(0);
  expect(listReviews(db)).toHaveLength(2);
});

test("undo restores gloss and mark, and is disabled once either changed since", async () => {
  const db = freshDb();
  const id = seed(db, "tylko", { gloss: "ma anche", senses: [["only", "solo"]], flagged: "" });
  await reviewReports(
    db,
    fake([{ gloss: { sense: 0 }, contextBound: true, names: [], reason: "x" }]),
  );
  const [review] = listReviews(db);
  expect(review.undoable).toBe(true);

  undoReview(db, review.reviewId!);
  expect(primary(db, id)).toMatchObject({ italian: "ma anche", provider: "claude-cli" });
  expect(lemmaRow(db, id)).toMatchObject({ contextBound: false, flaggedAt: null });
  expect(listReviews(db)[0].undoable).toBe(false);

  // A second review, then the gloss is edited: no longer undoable.
  db.update(schema.lemma).set({ flaggedAt: new Date() }).where(eq(schema.lemma.id, id)).run();
  await reviewReports(
    db,
    fake([{ gloss: { sense: 0 }, contextBound: false, names: [], reason: "x" }]),
  );
  db.update(schema.gloss).set({ italian: "solamente" }).where(eq(schema.gloss.lemmaId, id)).run();
  const [latest] = listReviews(db);
  expect(latest.undoable).toBe(false);
  expect(() => undoReview(db, latest.reviewId!)).toThrow();
});

test("undoing a review that changed nothing files a Report the next review sees", async () => {
  const db = freshDb();
  const id = seed(db, "tylko", { gloss: "solo", flagged: "" });
  await reviewReports(
    db,
    fake([{ gloss: "keep", contextBound: false, names: [], reason: "Va bene." }]),
  );
  const [review] = listReviews(db);
  expect(review.changed).toBe(false);

  undoReview(db, review.reviewId!, "è sbagliata");
  expect(lemmaRow(db, id)).toMatchObject({ flagNote: "è sbagliata" });
  expect(lemmaRow(db, id).flaggedAt).not.toBeNull();

  const next = fake([{ gloss: "keep", contextBound: false, names: [], reason: "x" }]);
  await reviewReports(db, next);
  expect(next.calls[0][0]).toMatchObject({
    note: "è sbagliata",
    previous: { reason: "Va bene.", undone: true },
  });
});

function w(surface: string, lemma: string, pos: string) {
  return { surface, lemma, pos, tags: [], is_space: false };
}

/** "Smok Iskra leci. Iskra śpi. Widzę iskry." with the dragon stored as the noun, then as an adjective slip. */
function seedDragon(db: DB) {
  insertEntryBatch(db, [
    {
      word: "iskra",
      pos: "noun",
      ipa: null,
      etymology: null,
      isMwe: false,
      senses: [{ gloss: "spark", rawGloss: null, tags: [] }],
      forms: ["iskra", "iskry", "iskro"].map((form) => ({ form, tags: [] })),
    },
  ]);
  persistAnalysis(
    db,
    { content: "Smok Iskra leci. Iskra śpi. Widzę iskry." },
    {
      sentences: [
        {
          tokens: [
            w("Smok ", "smok", "NOUN"),
            w("Iskra ", "iskra", "NOUN"),
            w("leci.", "lecieć", "VERB"),
          ],
        },
        { tokens: [w("Iskra ", "iskra", "ADJ"), w("śpi.", "spać", "VERB")] },
        { tokens: [w("Widzę ", "widzieć", "VERB"), w("iskry.", "iskra", "NOUN")] },
      ],
    },
    new Date(),
    new Map(),
  );
  const rows = db
    .select({ id: schema.token.id, lemmaId: schema.token.lemmaId, surface: schema.token.surface })
    .from(schema.token)
    .all();
  const dragon = rows.find((t) => t.surface === "Iskra ")!;
  return { noun: dragon.lemmaId!, tokenId: dragon.id };
}

function lemmasOf(db: DB, surface: string) {
  return db
    .select({ lemma: schema.lemma.lemma, pos: schema.lemma.pos })
    .from(schema.token)
    .innerJoin(schema.lemma, eq(schema.token.lemmaId, schema.lemma.id))
    .where(eq(schema.token.surface, surface))
    .all();
}

test("a reader Report moves the Name uses to the Name and deletes the word left without tokens", async () => {
  const db = freshDb();
  const { noun, tokenId } = seedDragon(db);
  // The lowercase spark keeps the noun alive until it goes too.
  db.delete(schema.token).where(eq(schema.token.surface, "iskry.")).run();
  reportLemma(db, noun, "è il nome del drago", tokenId);
  const provider = fake([{ gloss: "keep", contextBound: false, names: [0, 1], reason: "Nome." }]);

  expect(await reviewReports(db, provider)).toBe(1);
  expect(provider.calls[0][0].names.map((c) => c.sentence)).toEqual([
    "Smok Iskra leci.",
    "Iskra śpi.",
  ]);
  expect(lemmasOf(db, "Iskra ")).toEqual([
    { lemma: "Iskra", pos: "PROPN" },
    { lemma: "Iskra", pos: "PROPN" },
  ]);
  const words = db.select().from(schema.lemma).where(eq(schema.lemma.lemma, "iskra")).all();
  expect(words).toHaveLength(0);
  expect(takeCorrections(db).map((c) => c.line)).toEqual(["iskra: 2 occorrenze ora Iskra"]);
});

test("undoing a Name decision returns the occurrences to the word, which starts as new", async () => {
  const db = freshDb();
  const { noun, tokenId } = seedDragon(db);
  db.delete(schema.token).where(eq(schema.token.surface, "iskry.")).run();
  reportLemma(db, noun, "", tokenId);
  await reviewReports(db, fake([{ gloss: "keep", contextBound: false, names: [0], reason: "x" }]));
  const [review] = listReviews(db);
  expect(review.undoable).toBe(true);

  undoReview(db, review.reviewId!);
  expect(lemmasOf(db, "Iskra ")).toEqual([
    { lemma: "iskra", pos: "NOUN" },
    { lemma: "iskra", pos: "ADJ" },
  ]);
  const [restored] = db
    .select({ id: schema.lemma.id })
    .from(schema.lemma)
    .where(and(eq(schema.lemma.lemma, "iskra"), eq(schema.lemma.pos, "NOUN")))
    .all();
  const state = db
    .select()
    .from(schema.knowledge)
    .where(eq(schema.knowledge.lemmaId, restored.id))
    .all();
  expect(state).toMatchObject([{ track: "receptive", reps: 0 }]);
  expect(listReviews(db)[0].undoable).toBe(false);
});

test("a Practice Report offers only capitalized occurrences, and a word with uses left stays", async () => {
  const db = freshDb();
  const { noun } = seedDragon(db);
  reportLemma(db, noun, "");
  const provider = fake([{ gloss: "keep", contextBound: false, names: [0], reason: "x" }]);

  expect(await reviewReports(db, provider)).toBe(1);
  expect(provider.calls[0][0].names.map((c) => c.sentence)).toEqual(["Smok Iskra leci."]);
  expect(lemmasOf(db, "iskry.")).toEqual([{ lemma: "iskra", pos: "NOUN" }]);
  expect(lemmasOf(db, "Iskra ")).toEqual([
    { lemma: "Iskra", pos: "PROPN" },
    { lemma: "iskra", pos: "ADJ" },
  ]);
});

test("a Name index outside the candidates leaves the Report pending", async () => {
  const db = freshDb();
  const { noun } = seedDragon(db);
  reportLemma(db, noun, "");
  expect(
    await reviewReports(
      db,
      fake([{ gloss: "keep", contextBound: false, names: [3], reason: "x" }]),
    ),
  ).toBe(0);
  expect(pendingReports(db)).toHaveLength(1);
});

test("a lemma an earlier verdict in the batch deleted is skipped, and the batch goes on", async () => {
  const db = freshDb();
  const { noun, tokenId } = seedDragon(db);
  db.delete(schema.token).where(eq(schema.token.surface, "iskry.")).run();
  const [adjective] = db
    .select({ id: schema.lemma.id })
    .from(schema.lemma)
    .where(and(eq(schema.lemma.lemma, "iskra"), eq(schema.lemma.pos, "ADJ")))
    .all();
  reportLemma(db, noun, "", tokenId);
  reportLemma(db, adjective.id, "");
  const tylko = seed(db, "tylko", { gloss: "ma anche", senses: [["only", "solo"]], flagged: "" });
  const provider = fake([
    { gloss: "keep", contextBound: false, names: [0, 1], reason: "Nome." },
    { gloss: "keep", contextBound: false, names: [0], reason: "Nome." },
    { gloss: { sense: 0 }, contextBound: false, names: [], reason: "x" },
  ]);

  expect(await reviewReports(db, provider)).toBe(2);
  expect(primary(db, tylko).italian).toBe("solo");
  expect(listReviews(db).map((r) => r.line)).toEqual([
    'tylko: "ma anche" → "solo"',
    "iskra: 2 occorrenze ora Iskra",
  ]);
});

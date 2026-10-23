import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import { senseKey } from "#/dictionary/service";
import type { GlossProvider, ReportReviewItem, ReportVerdict } from "#/llm/provider";
import { StubProvider } from "#/llm/stub";
import { listReviews, pendingReports, reviewReports, takeCorrections, undoReview } from "./review";

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
    { gloss: { sense: 5 }, contextBound: false, reason: "x" },
    { gloss: { sense: 0 }, contextBound: false, reason: "Forma flessa nella glossa." },
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
    { gloss: { italian: "soltanto", noSenseFits: false }, contextBound: false, reason: "x" },
  ]);
  expect(await reviewReports(db, reject)).toBe(0);

  const accept = fake([
    { gloss: { italian: "soltanto", noSenseFits: true }, contextBound: false, reason: "x" },
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
  await reviewReports(db, fake([{ gloss: { sense: 0 }, contextBound: false, reason: "x" }]));
  expect(primary(db, id)).toMatchObject({ italian: "solo", provider: "manual" });
});

test("a context-bound mark is reviewed once: turned off and its gloss replaced independently", async () => {
  const db = freshDb();
  const id = seed(db, "też", { gloss: "per", senses: [["also", "anche"]], contextBound: true });
  expect(pendingReports(db)).toMatchObject([{ lemma: "też", kind: "context" }]);

  await reviewReports(db, fake([{ gloss: { sense: 0 }, contextBound: false, reason: "x" }]));
  expect(lemmaRow(db, id).contextBound).toBe(false);
  expect(primary(db, id).italian).toBe("anche");

  // Marked again by the learner: pending again. Kept on by a review: settled.
  db.update(schema.lemma).set({ contextBound: true }).where(eq(schema.lemma.id, id)).run();
  expect(pendingReports(db)).toHaveLength(1);
  await reviewReports(db, fake([{ gloss: "keep", contextBound: true, reason: "x" }]));
  expect(pendingReports(db)).toHaveLength(0);
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
  seed(db, "do", { gloss: "a", contextBound: true });
  db.insert(schema.lemmaSlipRepair).values({ slip: "myśli", target: "myśleć" }).run();
  await reviewReports(
    db,
    fake([
      { gloss: { sense: 0 }, contextBound: false, reason: "x" },
      { gloss: "keep", contextBound: true, reason: "x" },
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
  await reviewReports(db, fake([{ gloss: { sense: 0 }, contextBound: true, reason: "x" }]));
  const [review] = listReviews(db);
  expect(review.undoable).toBe(true);

  undoReview(db, review.reviewId!);
  expect(primary(db, id)).toMatchObject({ italian: "ma anche", provider: "claude-cli" });
  expect(lemmaRow(db, id)).toMatchObject({ contextBound: false, flaggedAt: null });
  expect(listReviews(db)[0].undoable).toBe(false);

  // A second review, then the gloss is edited: no longer undoable.
  db.update(schema.lemma).set({ flaggedAt: new Date() }).where(eq(schema.lemma.id, id)).run();
  await reviewReports(db, fake([{ gloss: { sense: 0 }, contextBound: false, reason: "x" }]));
  db.update(schema.gloss).set({ italian: "solamente" }).where(eq(schema.gloss.lemmaId, id)).run();
  const [latest] = listReviews(db);
  expect(latest.undoable).toBe(false);
  expect(() => undoReview(db, latest.reviewId!)).toThrow();
});

test("undoing a review that changed nothing files a Report the next review sees", async () => {
  const db = freshDb();
  const id = seed(db, "tylko", { gloss: "solo", flagged: "" });
  await reviewReports(db, fake([{ gloss: "keep", contextBound: false, reason: "Va bene." }]));
  const [review] = listReviews(db);
  expect(review.changed).toBe(false);

  undoReview(db, review.reviewId!, "è sbagliata");
  expect(lemmaRow(db, id)).toMatchObject({ flagNote: "è sbagliata" });
  expect(lemmaRow(db, id).flaggedAt).not.toBeNull();

  const next = fake([{ gloss: "keep", contextBound: false, reason: "x" }]);
  await reviewReports(db, next);
  expect(next.calls[0][0]).toMatchObject({
    note: "è sbagliata",
    previous: { reason: "Va bene.", undone: true },
  });
});

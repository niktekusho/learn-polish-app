import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, expect, test, vi } from "vitest";
import * as schema from "#/db/schema";
import { Rating, gradeLemma, initialKnowledgeFields } from "#/fsrs/index";
import {
  answerSpeechItem,
  buildSession,
  pronunciationRating,
  revealItem,
  selfGradeItem,
} from "./session";

// Speech grading calls the sidecar; tests stub it (the real roundtrip is
// covered by sidecar/test_transcribe.py).
vi.mock("#/import/sidecar", () => ({
  transcribe: vi.fn(),
  analyze: vi.fn(),
}));
import { analyze, transcribe } from "#/import/sidecar";

beforeEach(() => {
  vi.mocked(transcribe).mockReset();
  vi.mocked(analyze).mockReset();
});

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  return db;
}

function seed(db: ReturnType<typeof freshDb>, word: string, glossText: string) {
  const due = new Date("2026-01-01T00:00:00Z");
  const [{ id }] = db
    .insert(schema.lemma)
    .values({ lemma: word, pos: "NOUN" })
    .returning({ id: schema.lemma.id })
    .all();
  db.insert(schema.knowledge)
    .values({ lemmaId: id, track: "receptive", ...initialKnowledgeFields(due) })
    .run();
  db.insert(schema.gloss).values({ lemmaId: id, italian: glossText }).run();
  return id;
}

function seedFour(db: ReturnType<typeof freshDb>) {
  for (const [w, g] of [
    ["kot", "gatto"],
    ["pies", "cane"],
    ["dom", "casa"],
    ["woda", "acqua"],
  ] as const) {
    seed(db, w, g);
  }
}

const asAudio = () => new Blob(["x"], { type: "audio/ogg" });

function mockTranscript(text: string, lemmas: string[]) {
  vi.mocked(transcribe).mockResolvedValue(text);
  vi.mocked(analyze).mockResolvedValue({
    sentences: [
      {
        tokens: lemmas.map((l) => ({
          surface: l,
          lemma: l,
          pos: "NOUN",
          tags: [],
          is_space: false,
        })),
      },
    ],
  });
}

test("mic on: productive cards seeded; tracks interleave, each lemma once", () => {
  const db = freshDb();
  seedFour(db);

  const session = buildSession(db, { limit: 20, mic: true });

  const productiveRows = db
    .select()
    .from(schema.knowledge)
    .all()
    .filter((k) => k.track === "productive");
  expect(productiveRows).toHaveLength(4); // every glossed lemma got a New productive card

  // 4 lemmas, each once; productive and receptive take turns (equal shares)
  const kinds = session.items.map((i) => i.kind);
  expect(kinds).toEqual(["spoken-recall", "recognition-mcq", "spoken-recall", "recognition-mcq"]);
  // spoken items never leak the answer
  for (const item of session.items) {
    if (item.kind === "spoken-recall") expect("lemma" in item).toBe(false);
  }
});

test("a track with few dues yields its share to the others", () => {
  const db = freshDb();
  seedFour(db);
  seed(db, "kawa", "caffè");
  seed(db, "mleko", "latte");
  // productive cards exist for all six, but only kot's is due
  for (const l of db.select().from(schema.lemma).all()) {
    const due =
      l.lemma === "kot" ? new Date("2026-01-01T00:00:00Z") : new Date("2099-01-01T00:00:00Z");
    db.insert(schema.knowledge)
      .values({ lemmaId: l.id, track: "productive", ...initialKnowledgeFields(due) })
      .run();
  }

  // pronunciation is empty too: receptive takes every slot productive can't fill
  const session = buildSession(db, { limit: 6, mic: true });
  const kinds = session.items.map((i) => i.kind);
  expect(kinds.filter((k) => k === "spoken-recall")).toHaveLength(1);
  expect(kinds.filter((k) => k === "recognition-mcq")).toHaveLength(5);
});

test("PROPN gets no productive card and no spoken-recall item", () => {
  const db = freshDb();
  seedFour(db);
  // a glossed proper noun, due like everything else
  const due = new Date("2026-01-01T00:00:00Z");
  const [{ id }] = db
    .insert(schema.lemma)
    .values({ lemma: "Ola", pos: "PROPN" })
    .returning({ id: schema.lemma.id })
    .all();
  db.insert(schema.knowledge)
    .values({ lemmaId: id, track: "receptive", ...initialKnowledgeFields(due) })
    .run();
  db.insert(schema.gloss).values({ lemmaId: id, italian: "prontuario (nome proprio)" }).run();

  const session = buildSession(db, { limit: 20, mic: true });

  const productiveRows = db
    .select()
    .from(schema.knowledge)
    .all()
    .filter((k) => k.track === "productive");
  expect(productiveRows.map((k) => k.lemmaId)).not.toContain(id); // not seeded
  expect(productiveRows).toHaveLength(4); // the four common nouns only
  // every lemma once; the proper noun only ever as MCQ
  expect(session.items).toHaveLength(5);
  for (const i of session.items) {
    if (i.kind === "spoken-recall") expect(i.gloss).not.toBe("prontuario (nome proprio)");
  }
});

test("mic off: no productive seeding, no speaking items", () => {
  const db = freshDb();
  seedFour(db);
  const session = buildSession(db, { limit: 20, mic: false });
  expect(session.items.every((i) => i.kind === "recognition-mcq")).toBe(true);
  const productiveRows = db
    .select()
    .from(schema.knowledge)
    .all()
    .filter((k) => k.track === "productive");
  expect(productiveRows).toHaveLength(0);
});

test("ASR hit grades productive Good immediately, exactly once", async () => {
  const db = freshDb();
  seedFour(db);
  const session = buildSession(db, { limit: 20, mic: true });
  const spoken = session.items.find((i) => i.kind === "spoken-recall");
  if (!spoken || spoken.kind !== "spoken-recall") throw new Error("no spoken item");

  // The item's answer is server-held; figure out the target via its gloss.
  const target = { gatto: "kot", cane: "pies", casa: "dom", acqua: "woda" }[spoken.gloss] as string;
  mockTranscript(target, [target]);

  const res = await answerSpeechItem(db, session.sessionId, spoken.id, asAudio());
  expect(res.status).toBe("correct");
  const logs = db.select().from(schema.reviewLog).all();
  expect(logs).toHaveLength(1);
  expect(logs[0].track).toBe("productive");

  // replay: no second write
  const res2 = await answerSpeechItem(db, session.sessionId, spoken.id, asAudio());
  expect(res2.status).toBe("alreadyAnswered");
  expect(db.select().from(schema.reviewLog).all()).toHaveLength(1);
});

test("ASR miss writes no FSRS; self-grade does, exactly once", async () => {
  const db = freshDb();
  seedFour(db);
  const session = buildSession(db, { limit: 20, mic: true });
  const spoken = session.items.find((i) => i.kind === "spoken-recall");
  if (!spoken || spoken.kind !== "spoken-recall") throw new Error("no spoken item");

  mockTranscript("zupełnie co innego", ["zupełnie", "co", "inny"]);
  const res = await answerSpeechItem(db, session.sessionId, spoken.id, asAudio());
  expect(res.status).toBe("miss");
  expect(res.answer).toBeTruthy(); // reveal
  expect(db.select().from(schema.reviewLog).all()).toHaveLength(0); // no write yet

  const g1 = selfGradeItem(db, session.sessionId, spoken.id, true);
  expect(g1.alreadyAnswered).toBe(false);
  expect(db.select().from(schema.reviewLog).all()).toHaveLength(1);

  const g2 = selfGradeItem(db, session.sessionId, spoken.id, false);
  expect(g2.alreadyAnswered).toBe(true);
  expect(db.select().from(schema.reviewLog).all()).toHaveLength(1);
});

/** Give a lemma a sentence occurrence so read-aloud applies to it. */
function seedSentence(db: ReturnType<typeof freshDb>, lemmaId: number, words: string[]) {
  const [{ id: textId }] = db
    .insert(schema.sourceText)
    .values({ content: words.join(" ") })
    .returning({ id: schema.sourceText.id })
    .all();
  db.insert(schema.token)
    .values(
      words.map((w, i) => ({
        textId,
        lemmaId: i === 0 ? lemmaId : null, // target sits at position 0
        surface: i < words.length - 1 ? `${w} ` : w,
        position: i,
        sentenceIndex: 0,
      })),
    )
    .run();
}

function lemmaId(db: ReturnType<typeof freshDb>, word: string) {
  return db
    .select()
    .from(schema.lemma)
    .all()
    .find((l) => l.lemma === word)!.id;
}

/** kot: reviewed once on receptive + a sentence -> eligible for pronunciation. */
function seedReadable(db: ReturnType<typeof freshDb>) {
  seedFour(db);
  const kotId = lemmaId(db, "kot");
  gradeLemma(db, kotId, "receptive", Rating.Good); // reviewed just now: receptive not due
  seedSentence(db, kotId, ["Kot", "pije", "wodę."]);
  // productive card not due, so spoken recall doesn't claim kot first
  db.insert(schema.knowledge)
    .values({
      lemmaId: kotId,
      track: "productive",
      ...initialKnowledgeFields(new Date("2099-01-01T00:00:00Z")),
    })
    .run();
  return kotId;
}

function readAloudItem(session: ReturnType<typeof buildSession>) {
  const ra = session.items.find((i) => i.kind === "read-aloud");
  if (!ra || ra.kind !== "read-aloud") throw new Error("no read-aloud item");
  return ra;
}

const pronLogs = (db: ReturnType<typeof freshDb>) =>
  db
    .select()
    .from(schema.reviewLog)
    .all()
    .filter((l) => l.track === "pronunciation");

test("pronunciation rating table (ADR-0005)", () => {
  expect(pronunciationRating({ hit: true, misses: 0 })).toBe(Rating.Good);
  expect(pronunciationRating({ hit: true, misses: 2 })).toBe(Rating.Hard);
  expect(pronunciationRating({ hit: false, misses: 1 })).toBe(Rating.Again);
  expect(pronunciationRating({ hit: false, misses: 0 })).toBeNull();
});

test("pronunciation card only after a receptive review, and only with a sentence", () => {
  const db = freshDb();
  const kotId = seedReadable(db);
  seedSentence(db, lemmaId(db, "pies"), ["Pies", "śpi."]); // sentence, but still New
  gradeLemma(db, lemmaId(db, "dom"), "receptive", Rating.Good); // reviewed, no sentence

  const session = buildSession(db, { limit: 20, mic: true });
  const pron = db
    .select()
    .from(schema.knowledge)
    .all()
    .filter((k) => k.track === "pronunciation");
  expect(pron.map((k) => k.lemmaId)).toEqual([kotId]);
  expect(readAloudItem(session).sentence).toBe("Kot pije wodę.");
  expect("lemma" in readAloudItem(session)).toBe(false); // graded word stays server-side
});

test("read-aloud: clean first hit grades pronunciation Good, never receptive", async () => {
  const db = freshDb();
  const kotId = seedReadable(db);
  const session = buildSession(db, { limit: 20, mic: true });
  const ra = readAloudItem(session);
  const before = db.select().from(schema.reviewLog).all().length;

  mockTranscript("kot pije wodę", ["kot", "pić", "woda"]);
  const res = await answerSpeechItem(db, session.sessionId, ra.id, asAudio());
  expect(res.status).toBe("correct");
  expect(res.hint).toMatchObject({ lemma: "kot" });
  const logs = db.select().from(schema.reviewLog).all().slice(before);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({ track: "pronunciation", lemmaId: kotId, rating: Rating.Good });
});

test('read-aloud: hit after misses is Hard; misses then "said it" is Hard', async () => {
  const db = freshDb();
  seedReadable(db);
  const s1 = buildSession(db, { limit: 20, mic: true });
  const ra = readAloudItem(s1);

  mockTranscript("ko", ["ko"]);
  expect((await answerSpeechItem(db, s1.sessionId, ra.id, asAudio())).status).toBe("miss");
  expect((await answerSpeechItem(db, s1.sessionId, ra.id, asAudio())).status).toBe("miss");
  expect(pronLogs(db)).toHaveLength(0); // misses write nothing yet
  mockTranscript("kot pije wodę", ["kot", "pić", "woda"]);
  expect((await answerSpeechItem(db, s1.sessionId, ra.id, asAudio())).status).toBe("correct");
  expect(pronLogs(db).map((l) => l.rating)).toEqual([Rating.Hard]);

  const db2 = freshDb();
  seedReadable(db2);
  const s2 = buildSession(db2, { limit: 20, mic: true });
  const ra2 = readAloudItem(s2);
  mockTranscript("ko", ["ko"]);
  await answerSpeechItem(db2, s2.sessionId, ra2.id, asAudio());
  const g = selfGradeItem(db2, s2.sessionId, ra2.id, true);
  expect(g.hint).toBeTruthy();
  expect(pronLogs(db2).map((l) => l.rating)).toEqual([Rating.Hard]);
});

test("spoken recall: retries after the reveal grade pronunciation, never productive", async () => {
  const db = freshDb();
  seedFour(db);
  const session = buildSession(db, { limit: 20, mic: true });
  const spoken = session.items.find((i) => i.kind === "spoken-recall");
  if (!spoken || spoken.kind !== "spoken-recall") throw new Error("no spoken item");
  const target = { gatto: "kot", cane: "pies", casa: "dom", acqua: "woda" }[spoken.gloss] as string;

  // give up, then say it right off the screen: heard, but NOT a recall
  revealItem(session.sessionId, spoken.id);
  mockTranscript("xyz", ["xyz"]);
  expect((await answerSpeechItem(db, session.sessionId, spoken.id, asAudio())).status).toBe("miss");
  mockTranscript(target, [target]);
  const res = await answerSpeechItem(db, session.sessionId, spoken.id, asAudio());
  expect(res.status).toBe("heard");
  expect(db.select().from(schema.reviewLog).all()).toHaveLength(0); // waits for self-grade

  const g = selfGradeItem(db, session.sessionId, spoken.id, false);
  expect(g.hint).toMatchObject({ lemma: target });
  const logs = db.select().from(schema.reviewLog).all();
  expect(logs.map((l) => [l.track, l.rating])).toEqual([
    ["productive", Rating.Again], // the verdict on the pre-reveal attempt
    ["pronunciation", Rating.Hard], // 1 visible miss, then a hit
  ]);
});

test("reveal (give-up) grades nothing until self-grade", () => {
  const db = freshDb();
  seedFour(db);
  const session = buildSession(db, { limit: 20, mic: true });
  const spoken = session.items.find((i) => i.kind === "spoken-recall");
  if (!spoken || spoken.kind !== "spoken-recall") throw new Error("no spoken item");

  const { answer } = revealItem(session.sessionId, spoken.id);
  expect(answer).toBeTruthy();
  expect(db.select().from(schema.reviewLog).all()).toHaveLength(0);

  selfGradeItem(db, session.sessionId, spoken.id, false);
  const logs = db.select().from(schema.reviewLog).all();
  expect(logs).toHaveLength(1);
  expect(logs[0].rating).toBe(1); // Again
});

test('spoken recall "I didn\'t" queues a Retry that grades nothing; "I said it" queues none', async () => {
  const db = freshDb();
  seedFour(db);
  const session = buildSession(db, { limit: 20, mic: true });
  const [first, second] = session.items.filter((i) => i.kind === "spoken-recall");
  if (first?.kind !== "spoken-recall" || second?.kind !== "spoken-recall") {
    throw new Error("expected two spoken items");
  }

  revealItem(session.sessionId, first.id);
  const missed = selfGradeItem(db, session.sessionId, first.id, false);
  expect(missed.retry).toMatchObject({ kind: "spoken-recall", gloss: first.gloss, retry: true });
  expect(db.select().from(schema.reviewLog).all()).toHaveLength(1);

  const target = { gatto: "kot", cane: "pies", casa: "dom", acqua: "woda" }[first.gloss] as string;
  mockTranscript(target, [target]);
  const res = await answerSpeechItem(db, session.sessionId, missed.retry!.id, asAudio());
  expect(res.status).toBe("correct");
  expect(res.hint).toBeUndefined();
  expect(db.select().from(schema.reviewLog).all()).toHaveLength(1);

  revealItem(session.sessionId, second.id);
  expect(selfGradeItem(db, session.sessionId, second.id, true).retry).toBeUndefined();
});

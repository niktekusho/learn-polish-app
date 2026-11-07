import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import type { ConversationSession, SessionSeed, TurnResult } from "#/llm/conversation-session";
import type { DebriefRequest, SceneRequest, SceneResult } from "#/llm/provider";
import { ScriptedSession } from "#/llm/scripted-session";
import { saveLearnerProfile } from "#/profile/service";
import { upsertLemma } from "#/import/pipeline";
import type { AnalyzeResponse } from "#/import/sidecar";
import { gradeLemma, type Track } from "#/fsrs/index";
import { insertEntryBatch } from "#/dictionary/loader";
import { conversationService } from "./service";

const NOW = new Date("2026-11-07T10:00:00");

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  return db;
}
type DB = ReturnType<typeof freshDb>;

const PROFILE = {
  name: "Marco",
  job: "programmatore",
  city: "Milano",
  partner: "Ola",
  hobbies: "",
};
const CATALOG = [
  { id: "gosia", label: "Voce femminile" },
  { id: "bass", label: "Voce maschile" },
];

function sceneReply(n: number, req: SceneRequest): SceneResult {
  return {
    character: 1,
    scene: `Scena ${n}`,
    steps: [`Passo A${n}`, `Passo B${n}`, `Passo C${n}`],
    roleFacts: n % 2 ? null : `Ruolo ${n}`,
    opening: {
      line: `Otwarcie ${n}.`,
      italian: `Apertura ${n}.`,
      hint: [n % 2 ? "chleb" : "bułka", `xyz${n}`],
      modelLine: `Poproszę chleb ${n}.`,
    },
    voices: req.voices && req.characters.map((_, i) => req.voices![i % req.voices!.length].id),
  };
}

/**
 * Answers each scene call in turn; an Error in `fails` fails that call instead. A Debrief
 * corrects each learner line, so its corrections follow the transcript it was sent.
 */
function fakeProvider(fails: (Error | null)[] = []) {
  return {
    requests: [] as SceneRequest[],
    debriefs: [] as { req: DebriefRequest; conversationId: number }[],
    async scene(req: SceneRequest) {
      this.requests.push(req);
      const fail = fails.shift();
      if (fail) throw fail;
      return sceneReply(this.requests.length, req);
    },
    async debrief(req: DebriefRequest, conversationId: number) {
      this.debriefs.push({ req, conversationId });
      const fail = fails.shift();
      if (fail) throw fail;
      return req.transcript
        .filter((l) => l.speaker === "learner")
        .map((l, i) => ({ said: l.text, corrected: `${l.text}!`, italian: `Regola ${i + 1}.` }));
    },
  };
}

function entry(word: string, pos: string, forms: string[] = []) {
  return {
    word,
    pos,
    ipa: null,
    etymology: null,
    isMwe: word.includes(" "),
    senses: [{ gloss: word, rawGloss: null, tags: [] }],
    forms: forms.map((form) => ({ form, tags: [] })),
  };
}

/** Splits on spaces; each word is its own lowercased lemma. */
async function fakeAnalyze(text: string): Promise<AnalyzeResponse> {
  const tokens = text
    .split(" ")
    .flatMap((w, i) => [
      ...(i ? [{ surface: " ", lemma: " ", pos: "SPACE", tags: [], is_space: true }] : []),
      { surface: w, lemma: w.toLowerCase(), pos: "NOUN", tags: [], is_space: false },
    ]);
  return { sentences: [{ tokens }] };
}

/** A story with two characters and `episodes` read Episodes. Returns their text ids. */
function seedStory(db: DB, episodes = 1): number[] {
  const [s] = db
    .insert(schema.story)
    .values({
      title: "Kot",
      genre: "giallo",
      hook: "h",
      outline: {
        plot: "p",
        characters: ["Ala – una ragazza", "Pan Jan – il vicino"],
        beats: ["a", "b", "c"],
      },
      plannedEpisodes: 3,
      status: "active",
    })
    .returning()
    .all();
  return Array.from({ length: episodes }, (_, i) => {
    const [e] = db
      .insert(schema.sourceText)
      .values({ content: `Odcinek ${i + 1}.`, storyId: s.id, episodeNumber: i + 1, readAt: NOW })
      .returning()
      .all();
    return e.id;
  });
}

/** A session that answers from `replies`; an Error fails that send. Records what it was given. */
class QueuedSession implements ConversationSession {
  warmed: SessionSeed[] = [];
  sent: string[] = [];
  lastTurns: boolean[] = []; // per send, whether the character was told to close the scene
  constructor(private readonly replies: (Partial<TurnResult> | Error)[]) {}
  async start(): Promise<TurnResult> {
    throw new Error("the service never starts a session");
  }
  warm(seed: SessionSeed) {
    this.warmed.push(seed);
  }
  async send(learnerTurn: string, options?: { lastTurn?: boolean }): Promise<TurnResult> {
    this.sent.push(learnerTurn);
    this.lastTurns.push(options?.lastTurn ?? false);
    const next = this.replies.shift() ?? {};
    if (next instanceof Error) throw next;
    return {
      line: "Tak.",
      italian: "Sì.",
      understood: true,
      stepsTicked: [],
      hint: [],
      modelLine: "Tak.",
      ...next,
    };
  }
  close() {}
}

function setup({
  profile = true,
  fails = [] as (Error | null)[],
  episodes = 1,
  session = () => new ScriptedSession() as ConversationSession,
  analyze = fakeAnalyze,
} = {}) {
  const db = freshDb();
  if (profile) saveLearnerProfile(db, PROFILE);
  insertEntryBatch(db, [
    entry("chleb", "noun", ["chleb", "chleba"]),
    entry("bułka", "noun", ["bułki"]),
    entry("Kraków", "name", ["Krakowa"]),
    entry("poprosić", "verb", ["poproszę"]),
    entry("proszę", "particle"),
    entry("to wszystko", "phrase"),
  ]);
  const episodeIds = seedStory(db, episodes);
  const provider = fakeProvider(fails);
  const sessions: ConversationSession[] = [];
  const svc = conversationService(db, {
    provider,
    voices: async () => CATALOG,
    analyze,
    createSession: () => {
      const s = session();
      sessions.push(s);
      return s;
    },
    now: () => NOW,
  });
  return { db, provider, sessions, svc, episodeIds };
}

test("a scene prepared when the Episode is read is served on open without another call", async () => {
  const { provider, svc, episodeIds } = setup();
  await svc.prepareScene(episodeIds[0]);
  expect(provider.requests).toHaveLength(1);

  const current = await svc.current();
  expect(provider.requests).toHaveLength(1);
  expect(current).toMatchObject({
    needsProfile: false,
    conversation: {
      character: "Jan",
      scene: "Scena 1",
      steps: [
        { text: "Passo A1", ticked: false },
        { text: "Passo B1", ticked: false },
        { text: "Passo C1", ticked: false },
      ],
      opening: { line: "Otwarcie 1.", italian: "Apertura 1." },
      turns: [],
    },
  });
});

test("when the background preparation failed, opening prepares the scene", async () => {
  const { provider, svc, episodeIds } = setup({ fails: [new Error("timeout")] });
  await expect(svc.prepareScene(episodeIds[0])).rejects.toThrow("timeout");

  const current = await svc.current();
  expect(provider.requests).toHaveLength(2);
  expect(current).toMatchObject({ conversation: { scene: "Scena 2" } });
});

test("without a Learner profile no scene is prepared and opening asks for the profile", async () => {
  const { provider, svc, episodeIds } = setup({ profile: false });
  await svc.prepareScene(episodeIds[0]);
  expect(await svc.current()).toEqual({ needsProfile: true });
  expect(provider.requests).toHaveLength(0);
});

test("the scene follows the last Episode read, with its text and the Learner profile", async () => {
  const { provider, svc } = setup({ episodes: 2 });
  expect(await svc.current()).toMatchObject({ conversation: { scene: "Scena 1" } });
  expect(provider.requests[0]).toMatchObject({
    episode: "Odcinek 2.",
    characters: ["Ala – una ragazza", "Pan Jan – il vicino"],
    profile: PROFILE,
  });
});

test("each Story character gets a voice on the first Conversation and keeps it", async () => {
  const { db, provider, svc, episodeIds } = setup({ episodes: 2 });
  await svc.prepareScene(episodeIds[0]);
  await svc.prepareScene(episodeIds[1]);

  expect(provider.requests.map((r) => r.voices)).toEqual([CATALOG, null]);
  expect(
    db.select().from(schema.characterVoice).orderBy(schema.characterVoice.character).all(),
  ).toMatchObject([
    { character: "Ala", voice: "gosia" },
    { character: "Jan", voice: "bass" },
  ]);
  expect(await svc.current()).toMatchObject({ conversation: { character: "Jan", voice: "bass" } });
});

test("the scene is nudged toward the due Productive lemmas of the moment", async () => {
  const { db, provider, svc, episodeIds } = setup();
  const [l] = db.insert(schema.lemma).values({ lemma: "chleb", pos: "NOUN" }).returning().all();
  db.insert(schema.knowledge)
    .values({
      lemmaId: l.id,
      track: "productive",
      state: 2,
      stability: 3,
      due: new Date("2026-11-06"),
      lastReview: new Date("2026-11-01"),
    })
    .run();
  await svc.prepareScene(episodeIds[0]);
  expect(provider.requests[0].dueLemmas).toEqual(["chleb"]);
});

test("reroll replaces the Goal, role facts, opening and first Hint pair", async () => {
  const { db, svc, episodeIds } = setup();
  await svc.prepareScene(episodeIds[0]);
  const before = db.select().from(schema.conversation).get()!;

  const after = await svc.reroll(before.id);
  expect(after).toMatchObject({
    id: before.id,
    scene: "Scena 2",
    roleFacts: "Ruolo 2",
    steps: [{ text: "Passo A2" }, { text: "Passo B2" }, { text: "Passo C2" }],
    opening: { line: "Otwarcie 2." },
  });
  const rows = db.select().from(schema.conversation).all();
  expect(rows).toHaveLength(1);
  expect(rows[0].opening).toMatchObject({ hint: ["bułka"], modelLine: "Poproszę chleb 2." });
});

test("a scene cannot be rerolled once the learner has spoken", async () => {
  const { svc, episodeIds } = setup();
  await svc.prepareScene(episodeIds[0]);
  const { conversation } = (await svc.current()) as { conversation: { id: number } };
  svc.addTurn(conversation.id, "Dzień dobry.");
  await expect(svc.reroll(conversation.id)).rejects.toThrow(/spoken/);
});

async function opened(replies: (Partial<TurnResult> | Error)[], analyze = fakeAnalyze) {
  const queued = new QueuedSession(replies);
  const ctx = setup({ session: () => queued, analyze });
  const current = await ctx.svc.current();
  const id = (current as { conversation: { id: number } }).conversation.id;
  return { ...ctx, id, queued };
}

test("a learner turn is stored before the session is asked for a reply", async () => {
  const { svc, id, queued } = await opened([]);
  svc.addTurn(id, "Dzień dobry.");
  expect(queued.sent).toEqual([]);
  expect(
    ((await svc.current()) as { conversation: { turns: unknown[] } }).conversation.turns,
  ).toMatchObject([{ learnerText: "Dzień dobry.", line: null, italian: null, revealed: false }]);

  expect(await svc.reply(id)).toMatchObject({ turn: 1, line: "Tak.", italian: "Sì." });
  expect(queued.sent).toEqual(["Dzień dobry."]);
});

test("a turn ticks zero, one or several Goal steps, and a ticked step stays ticked", async () => {
  const { svc, id } = await opened([
    { stepsTicked: [] },
    { stepsTicked: ["s1", "s3"] },
    { stepsTicked: ["s1"] },
    { stepsTicked: [] },
  ]);
  const ticked = async (text: string) => {
    svc.addTurn(id, text);
    return (await svc.reply(id)).steps.map((s) => s.ticked);
  };
  expect(await ticked("Dzień dobry.")).toEqual([false, false, false]);
  expect(await ticked("Poproszę chleb i płacę.")).toEqual([true, false, true]);
  expect(await ticked("Poproszę chleb.")).toEqual([true, false, true]);
  expect(await ticked("Do widzenia.")).toEqual([true, false, true]);
});

test("a step keeps the turn that first ticked it", async () => {
  const { db, svc, id } = await opened([{ stepsTicked: ["s2"] }, { stepsTicked: ["s2", "s1"] }]);
  for (const text of ["a", "b"]) {
    svc.addTurn(id, text);
    await svc.reply(id);
  }
  const { steps } = db.select().from(schema.conversation).get()!;
  expect(steps.map((s) => s.tickedTurn)).toEqual([2, 1, null]);
});

test("a failed reply keeps the learner turn, and asking again answers it", async () => {
  const { db, svc, id } = await opened([new Error("timed out")]);
  svc.addTurn(id, "Dzień dobry.");
  await expect(svc.reply(id)).rejects.toThrow("timed out");
  expect(() => svc.addTurn(id, "Halo?")).toThrow(/waiting/);

  expect(await svc.reply(id)).toMatchObject({ turn: 1, line: "Tak." });
  expect(db.select().from(schema.conversationTurn).all()).toMatchObject([
    { turn: 1, learnerText: "Dzień dobry.", line: "Tak.", attempts: 2 },
  ]);
});

test("opening the screen warms one session seeded with the brief and the transcript so far", async () => {
  const { db, svc, id, queued } = await opened([]);
  // A Conversation left yesterday: one answered turn and one still waiting.
  db.insert(schema.conversationTurn)
    .values([
      { conversationId: id, turn: 1, learnerText: "Dzień dobry.", line: "Dzień dobry, Marco." },
      { conversationId: id, turn: 2, learnerText: "Poproszę chleb." },
    ])
    .run();
  db.update(schema.conversation).set({ turnCount: 2 }).run();

  svc.open(id);
  svc.open(id);
  expect(queued.warmed).toHaveLength(1);
  const seed = queued.warmed[0];
  expect(seed.stepIds).toEqual(["s1", "s2", "s3"]);
  expect(seed.brief).toContain("Pan Jan – il vicino");
  expect(seed.brief).toContain("Marco");
  // The pending turn is not in the seed: the next reply sends it.
  expect(seed.transcript).toEqual([
    { speaker: "character", text: "Otwarcie 1." },
    { speaker: "learner", text: "Dzień dobry." },
    { speaker: "character", text: "Dzień dobry, Marco." },
  ]);
});

test("in dev the scripted stub session plays the scene and ticks its steps", async () => {
  const { svc } = setup();
  const { conversation } = (await svc.current()) as { conversation: { id: number } };
  svc.open(conversation.id);
  svc.addTurn(conversation.id, "Poproszę dwie bułki.");
  const reply = await svc.reply(conversation.id);
  expect(reply.line).toBe("Dwie bułki, proszę bardzo. Coś jeszcze?");
  expect(reply.steps.map((s) => s.ticked)).toEqual([true, false, false]);
});

test("after a reroll the next session is briefed with the new Goal", async () => {
  const seeds: SessionSeed[] = [];
  const ctx = setup({
    session: () => {
      const s = new QueuedSession([]);
      s.warm = (seed) => void seeds.push(seed);
      return s;
    },
  });
  const { conversation } = (await ctx.svc.current()) as { conversation: { id: number } };
  ctx.svc.open(conversation.id);
  await ctx.svc.reroll(conversation.id);
  ctx.svc.open(conversation.id);
  expect(seeds.map((s) => s.brief.includes("Passo A2"))).toEqual([false, true]);
});

test("character lines start hidden; revealing one is stored and the rest count as Heard lines", async () => {
  const { svc, id } = await opened([{ line: "Tak." }, { line: "Nie." }]);
  for (const text of ["a", "b"]) {
    svc.addTurn(id, text);
    await svc.reply(id);
  }
  svc.addTurn(id, "c"); // still waiting: no character line yet
  expect(svc.heardLines(id)).toBe(3);

  svc.reveal(id, 0);
  svc.reveal(id, 2);
  const { conversation } = (await svc.current()) as {
    conversation: { opening: { revealed: boolean }; turns: { revealed: boolean }[] };
  };
  expect(conversation.opening.revealed).toBe(true);
  expect(conversation.turns.map((t) => t.revealed)).toEqual([false, true, false]);
  expect(svc.heardLines(id)).toBe(1);

  svc.reveal(id, 3); // no line yet: its reply arrives hidden
  await svc.reply(id);
  expect(svc.heardLines(id)).toBe(2);
});

test("a revealed line's words carry their lemmas, and neither reveal nor lookup grades anything", async () => {
  const { db, svc, id } = await opened([{ line: "Masz chleb" }]);
  gradeLemma(db, upsertLemma(db, "chleb", "NOUN"), "receptive", 4, NOW);
  svc.addTurn(id, "Dzień dobry.");
  await svc.reply(id);
  const knowledgeBefore = db.select().from(schema.knowledge).all();
  const reviewsBefore = db.select().from(schema.reviewLog).all();

  svc.reveal(id, 1);
  const words = await svc.words(id, 1);
  expect(words).toMatchObject([
    { surface: "Masz", lemma: "masz", pos: "NOUN", isSpace: false, known: false },
    { surface: " ", lemmaId: null, isSpace: true },
    { surface: "chleb", lemma: "chleb", known: true },
  ]);
  expect(words[0].lemmaId).toEqual(expect.any(Number));
  expect((await svc.words(id, 0)).map((w) => w.surface)).toEqual(["Otwarcie", " ", "1."]);

  expect(db.select().from(schema.knowledge).all()).toEqual(knowledgeBefore);
  expect(db.select().from(schema.reviewLog).all()).toEqual(reviewsBefore);
});

test("a rerolled opening starts hidden again", async () => {
  const { svc, id } = await opened([]);
  svc.reveal(id, 0);
  expect((await svc.reroll(id)).opening.revealed).toBe(false);
  expect(svc.heardLines(id)).toBe(1);
});

test("a Hint word absent from the Home dictionary's forms is not shown", async () => {
  const { svc, id } = await opened([
    {
      hint: ["Poproszę", "chleba,", "xyzzy", "to wszystko", "proszę bardzo", "Kraków", "?"],
      modelLine: "M.",
    },
  ]);
  expect((await svc.current()) as unknown).toMatchObject({
    conversation: { opening: { hint: ["chleb"], modelLine: "Poproszę chleb 1." } },
  });
  svc.addTurn(id, "Dzień dobry.");
  expect(await svc.reply(id)).toMatchObject({
    hint: ["Poproszę", "chleba,", "to wszystko", "Kraków"],
    modelLine: "M.",
  });
  expect((await svc.current()) as unknown).toMatchObject({
    conversation: {
      turns: [{ hint: ["Poproszę", "chleba,", "to wszystko", "Kraków"], modelLine: "M." }],
    },
  });
});

test("Hint and Model line reveals are stored on the turn that offers them, with no LLM call, and a later Hint tap keeps the Model line", async () => {
  const { provider, svc, id, queued } = await opened([{}, {}]);
  svc.revealHelp(id, 0, "modelLine");
  svc.revealHelp(id, 0, "hint");
  for (const text of ["a", "b"]) {
    svc.addTurn(id, text);
    await svc.reply(id);
  }
  svc.revealHelp(id, 1, "hint");

  expect((await svc.current()) as unknown).toMatchObject({
    conversation: { opening: { help: "modelLine" }, turns: [{ help: "hint" }, { help: null }] },
  });
  expect(provider.requests).toHaveLength(1);
  expect(queued.sent).toEqual(["a", "b"]);
});

test("nothing about Help ladder reveals reaches the session", async () => {
  const { svc, id, queued } = await opened([{ hint: ["chleba"], modelLine: "Poproszę chleba." }]);
  svc.revealHelp(id, 0, "modelLine");
  svc.open(id);
  svc.addTurn(id, "Poproszę chleb 1.");
  await svc.reply(id);
  svc.revealHelp(id, 1, "modelLine");
  svc.addTurn(id, "Poproszę chleba.");
  await svc.reply(id);

  expect(queued.sent).toEqual(["Poproszę chleb 1.", "Poproszę chleba."]);
  expect(queued.warmed).toHaveLength(1);
  const seed = JSON.stringify(queued.warmed[0]);
  expect(seed).toContain("Otwarcie 1.");
  expect(seed).not.toMatch(/Poproszę chleb 1\.|Poproszę chleba\./);
});

/** A lemma the learner has met: a Receptive review from an earlier day. */
function met(db: DB, word: string) {
  const id = upsertLemma(db, word, "NOUN");
  gradeLemma(db, id, "receptive", 3, new Date("2026-11-01T10:00:00"));
  return id;
}

/** Knowledge rows and today's review log rows on a track, as [lemma, rating], sorted. */
function graded(db: DB, track: Track) {
  const names = new Map(
    db
      .select()
      .from(schema.lemma)
      .all()
      .map((l) => [l.id, l.lemma]),
  );
  return {
    knowledge: db
      .select()
      .from(schema.knowledge)
      .all()
      .filter((k) => k.track === track)
      .map((k) => names.get(k.lemmaId))
      .sort(),
    reviews: db
      .select()
      .from(schema.reviewLog)
      .orderBy(schema.reviewLog.id)
      .all()
      .filter((r) => r.track === track && r.reviewedAt >= new Date("2026-11-07T00:00:00"))
      .map((r) => [names.get(r.lemmaId), r.rating])
      .sort(),
  };
}

async function speak(svc: ReturnType<typeof setup>["svc"], id: number, text: string) {
  svc.addTurn(id, text);
  return svc.reply(id);
}

test("the met lemmas of a free, understood turn grade Productive Good, unmet lemmas get no Knowledge state, and nothing grades Receptive", async () => {
  const { db, svc, id } = await opened([]);
  met(db, "chleb");
  met(db, "mleko");
  await speak(svc, id, "Poproszę chleb i mleko");

  expect(graded(db, "productive")).toEqual({
    knowledge: ["chleb", "mleko"],
    reviews: [
      ["chleb", 3],
      ["mleko", 3],
    ],
  });
  expect(db.select().from(schema.knowledge).all()).toHaveLength(4);
  expect(graded(db, "receptive").reviews).toEqual([]);
});

test("a turn the character did not understand grades nothing", async () => {
  const { db, svc, id } = await opened([{ understood: false }]);
  met(db, "chleb");
  const before = db.select().from(schema.knowledge).all();
  await speak(svc, id, "chleb");

  expect(db.select().from(schema.knowledge).all()).toEqual(before);
  expect(graded(db, "productive").reviews).toEqual([]);
});

test("an Echo of the character's last two lines is not graded", async () => {
  const { db, svc, id } = await opened([{ line: "Masz chleb" }, { line: "Masz mleko" }, {}]);
  for (const w of ["chleb", "mleko", "ser", "otwarcie"]) met(db, w);
  await speak(svc, id, "a");
  await speak(svc, id, "b");
  // The opening ("Otwarcie 1.") is three lines back: "otwarcie" is free.
  await speak(svc, id, "chleb mleko ser otwarcie");

  expect(graded(db, "productive").reviews).toEqual([
    ["otwarcie", 3],
    ["ser", 3],
  ]);
});

test("a lemma from a revealed Hint that the learner then says grades Productive Again", async () => {
  const { db, svc, id } = await opened([{ hint: ["bułki"] }, {}]);
  for (const w of ["chleb", "mleko", "bułka"]) met(db, w);
  svc.revealHelp(id, 0, "hint"); // the opening's Hint: "chleb"
  await speak(svc, id, "chleb mleko");
  svc.revealHelp(id, 1, "hint");
  await speak(svc, id, "bułka"); // the lemma of the hinted "bułki"

  expect(graded(db, "productive").reviews).toEqual([
    ["bułka", 1],
    ["chleb", 1],
    ["mleko", 3],
  ]);
});

test("a Model line read aloud grades Pronunciation of the hinted lemmas, and nothing Productive", async () => {
  const { db, svc, id } = await opened([{ hint: ["bułki"] }, {}]);
  met(db, "chleb");
  met(db, "mleko");
  // Imported but never reviewed: not yet on the Pronunciation track.
  db.insert(schema.knowledge)
    .values({ lemmaId: upsertLemma(db, "bułka", "NOUN"), track: "receptive", due: NOW })
    .run();
  svc.revealHelp(id, 0, "modelLine"); // the opening's Hint: "chleb"
  await speak(svc, id, "Poproszę chleb mleko");
  svc.revealHelp(id, 1, "modelLine");
  await speak(svc, id, "bułka");

  expect(graded(db, "pronunciation")).toEqual({ knowledge: ["chleb"], reviews: [["chleb", 3]] });
  expect(graded(db, "productive")).toEqual({ knowledge: [], reviews: [] });
});

test("a lemma graded today on a track, by Practice or an earlier turn, is not graded again on it", async () => {
  const { db, svc, id } = await opened([{}, { hint: ["chleba"] }, {}]);
  const chleb = met(db, "chleb");
  met(db, "mleko");
  gradeLemma(db, chleb, "productive", 4, new Date("2026-11-07T08:00:00")); // this morning's Practice
  await speak(svc, id, "chleb mleko");
  await speak(svc, id, "mleko");
  svc.revealHelp(id, 2, "modelLine");
  await speak(svc, id, "chleb"); // another track: still graded

  expect(graded(db, "productive").reviews).toEqual([
    ["chleb", 4],
    ["mleko", 3],
  ]);
  expect(graded(db, "pronunciation").reviews).toEqual([["chleb", 3]]);
});

test("when the learner's words cannot be analyzed, the reply still arrives and grades nothing", async () => {
  let down = false;
  const analyze = (text: string) =>
    down ? Promise.reject(new Error("sidecar down")) : fakeAnalyze(text);
  const { db, svc, id, queued } = await opened([{ line: "Nie." }], analyze);
  met(db, "chleb");
  down = true;

  expect(await speak(svc, id, "chleb")).toMatchObject({ turn: 1, line: "Nie." });
  expect(queued.sent).toEqual(["chleb"]);
  expect(graded(db, "productive").reviews).toEqual([]);
});

/** Adds and answers learner turns until the Conversation has `n` of them. */
async function speakTurns(svc: ReturnType<typeof setup>["svc"], id: number, n: number) {
  let last;
  for (let i = 0; i < n; i++) {
    svc.addTurn(id, `Zdanie ${i + 1}.`);
    last = await svc.reply(id);
  }
  return last!;
}

test("the Debrief button is highlighted once every Goal step is ticked, without ending the scene", async () => {
  const { svc, id } = await opened([{ stepsTicked: ["s1", "s2"] }, { stepsTicked: ["s3"] }]);
  expect(await speakTurns(svc, id, 1)).toMatchObject({
    highlightDebrief: false,
    sceneClosed: false,
  });
  expect(await speakTurns(svc, id, 1)).toMatchObject({
    highlightDebrief: true,
    sceneClosed: false,
  });
  svc.addTurn(id, "Coś jeszcze.");
  expect(await svc.current()).toMatchObject({
    conversation: { status: "open", highlightDebrief: true },
  });
});

test("the Debrief button is highlighted at turn 15 with the Goal unmet", async () => {
  const { svc, id } = await opened([]);
  expect(await speakTurns(svc, id, 14)).toMatchObject({ highlightDebrief: false });
  expect(await speakTurns(svc, id, 1)).toMatchObject({
    highlightDebrief: true,
    sceneClosed: false,
  });
});

test("turn 25 tells the character to close the scene, and no further turn can be sent", async () => {
  const { svc, id, queued } = await opened([]);
  expect(await speakTurns(svc, id, 24)).toMatchObject({ sceneClosed: false });
  expect(await speakTurns(svc, id, 1)).toMatchObject({ turn: 25, sceneClosed: true });
  expect(queued.lastTurns.indexOf(true)).toBe(24);
  expect(queued.lastTurns.filter(Boolean)).toHaveLength(1);
  expect(() => svc.addTurn(id, "Jeszcze jedno.")).toThrow(/closed/);
  expect(await svc.current()).toMatchObject({ conversation: { sceneClosed: true } });
});

test("tapping Debrief mid-scene sends the transcript, stores the corrections and closes the scene", async () => {
  const { db, provider, svc, id } = await opened([{ line: "Dzień dobry." }, { line: "Proszę." }]);
  await speakTurns(svc, id, 2);
  svc.addTurn(id, "Halo?"); // still waiting for its reply: the learner's words still count

  const debriefed = await svc.debrief(id);
  expect(provider.debriefs).toHaveLength(1);
  expect(provider.debriefs[0].conversationId).toBe(id);
  expect(provider.debriefs[0].req.transcript).toEqual([
    { speaker: "character", text: "Otwarcie 1." },
    { speaker: "learner", text: "Zdanie 1." },
    { speaker: "character", text: "Dzień dobry." },
    { speaker: "learner", text: "Zdanie 2." },
    { speaker: "character", text: "Proszę." },
    { speaker: "learner", text: "Halo?" },
  ]);
  const corrections = [
    { said: "Zdanie 1.", corrected: "Zdanie 1.!", italian: "Regola 1." },
    { said: "Zdanie 2.", corrected: "Zdanie 2.!", italian: "Regola 2." },
    { said: "Halo?", corrected: "Halo?!", italian: "Regola 3." },
  ];
  expect(debriefed).toMatchObject({ status: "debriefed", corrections });
  expect(db.select().from(schema.conversation).get()).toMatchObject({
    status: "debriefed",
    corrections,
  });
  expect(() => svc.addTurn(id, "Jeszcze.")).toThrow(/closed/);
});

test("a debriefed Conversation is not offered again as open: it shows its Debrief", async () => {
  const { provider, svc, id } = await opened([]);
  await speakTurns(svc, id, 1);
  await svc.debrief(id);

  expect(await svc.current()).toMatchObject({
    conversation: { id, status: "debriefed", corrections: [{ said: "Zdanie 1." }] },
  });
  expect(await svc.debrief(id)).toMatchObject({ status: "debriefed" });
  expect(provider.debriefs).toHaveLength(1);
  await expect(svc.reroll(id)).rejects.toThrow();
});

test("a Debrief before the learner has spoken asks nothing and has no corrections", async () => {
  const { provider, svc, id } = await opened([]);
  expect(await svc.debrief(id)).toMatchObject({ status: "debriefed", corrections: [] });
  expect(provider.debriefs).toHaveLength(0);
});

test("a failed Debrief call leaves the scene open, and tapping again retries it", async () => {
  const queued = new QueuedSession([]);
  const { svc, provider } = setup({ session: () => queued, fails: [null, new Error("timeout")] });
  const { conversation } = (await svc.current()) as { conversation: { id: number } };
  await speakTurns(svc, conversation.id, 1);

  await expect(svc.debrief(conversation.id)).rejects.toThrow("timeout");
  expect(await svc.current()).toMatchObject({ conversation: { status: "open" } });
  expect(await svc.debrief(conversation.id)).toMatchObject({ status: "debriefed" });
  expect(provider.debriefs).toHaveLength(2);
});

test("at most 10 corrections are stored, in the order the Debrief gave them", async () => {
  const { db, svc, id } = await opened([]);
  await speakTurns(svc, id, 12);
  const debriefed = await svc.debrief(id);
  const said = Array.from({ length: 10 }, (_, i) => `Zdanie ${i + 1}.`);
  expect(debriefed.corrections?.map((c) => c.said)).toEqual(said);
  expect(db.select().from(schema.conversation).get()!.corrections).toHaveLength(10);
});

test("a reply that arrives after the Debrief is not stored or graded", async () => {
  let answer: (r: TurnResult) => void = () => {};
  const slow = new QueuedSession([]);
  slow.send = () => new Promise((resolve) => (answer = resolve));
  const { db, svc, provider } = setup({ session: () => slow });
  const { conversation } = (await svc.current()) as { conversation: { id: number } };
  met(db, "chleb");
  svc.addTurn(conversation.id, "chleb");
  const pending = svc.reply(conversation.id);

  await svc.debrief(conversation.id);
  answer({
    line: "Tak.",
    italian: "Sì.",
    understood: true,
    stepsTicked: ["s1"],
    hint: [],
    modelLine: "",
  });
  await expect(pending).rejects.toThrow(/debriefed/);
  expect(provider.debriefs[0].req.transcript.at(-1)).toEqual({ speaker: "learner", text: "chleb" });
  expect(db.select().from(schema.conversationTurn).get()).toMatchObject({ line: null });
  expect(graded(db, "productive").knowledge).toEqual([]);
});

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import type { ConversationSession, SessionSeed, TurnResult } from "#/llm/conversation-session";
import type { SceneRequest, SceneResult } from "#/llm/provider";
import { ScriptedSession } from "#/llm/scripted-session";
import { saveLearnerProfile } from "#/profile/service";
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
      hint: [`chleb${n}`],
      modelLine: `Poproszę chleb ${n}.`,
    },
    voices: req.voices && req.characters.map((_, i) => req.voices![i % req.voices!.length].id),
  };
}

/** Answers each scene call in turn; an Error in `fails` fails that call instead. */
function fakeProvider(fails: (Error | null)[] = []) {
  return {
    requests: [] as SceneRequest[],
    async scene(req: SceneRequest) {
      this.requests.push(req);
      const fail = fails.shift();
      if (fail) throw fail;
      return sceneReply(this.requests.length, req);
    },
  };
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
  constructor(private readonly replies: (Partial<TurnResult> | Error)[]) {}
  async start(): Promise<TurnResult> {
    throw new Error("the service never starts a session");
  }
  warm(seed: SessionSeed) {
    this.warmed.push(seed);
  }
  async send(learnerTurn: string): Promise<TurnResult> {
    this.sent.push(learnerTurn);
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
} = {}) {
  const db = freshDb();
  if (profile) saveLearnerProfile(db, PROFILE);
  const episodeIds = seedStory(db, episodes);
  const provider = fakeProvider(fails);
  const sessions: ConversationSession[] = [];
  const svc = conversationService(db, {
    provider,
    voices: async () => CATALOG,
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
  expect(rows[0].opening).toMatchObject({ hint: ["chleb2"], modelLine: "Poproszę chleb 2." });
});

test("a scene cannot be rerolled once the learner has spoken", async () => {
  const { svc, episodeIds } = setup();
  await svc.prepareScene(episodeIds[0]);
  const { conversation } = (await svc.current()) as { conversation: { id: number } };
  svc.addTurn(conversation.id, "Dzień dobry.");
  await expect(svc.reroll(conversation.id)).rejects.toThrow(/spoken/);
});

async function opened(replies: (Partial<TurnResult> | Error)[]) {
  const queued = new QueuedSession(replies);
  const ctx = setup({ session: () => queued });
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
  ).toEqual([{ learnerText: "Dzień dobry.", line: null, italian: null }]);

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

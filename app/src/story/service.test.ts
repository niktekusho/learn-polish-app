import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, test, vi } from "vitest";
import * as schema from "#/db/schema";
import { initialKnowledgeFields } from "#/fsrs/index";
import type { AnalyzeResponse } from "#/import/sidecar";
import type { EpisodeRequest, StoryOutline, StoryProvider } from "#/llm/provider";
import { StubProvider } from "#/llm/stub";
import { storyService } from "./service";

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  return db;
}
type DB = ReturnType<typeof freshDb>;

// 20 known lemmas: a draft's new-word share is its count of other words / 20+.
const KNOWN = Array.from({ length: 20 }, (_, i) => `slowo${i}`);

function seedKnown(db: DB) {
  for (const w of KNOWN) {
    const [{ id }] = db
      .insert(schema.lemma)
      .values({ lemma: w, pos: "NOUN" })
      .returning({ id: schema.lemma.id })
      .all();
    db.insert(schema.knowledge)
      .values({ lemmaId: id, track: "receptive", ...initialKnowledgeFields() })
      .run();
  }
}

/** A draft of 20 known words plus `fresh` unknown ones (marked by episode tag). */
function draft(fresh: number, tag = "a") {
  const unknown = Array.from({ length: fresh }, (_, i) => `nowe${tag}${i}`);
  return [...KNOWN, ...unknown].join(" ");
}

// One sentence, every whitespace-separated word a NOUN whose lemma is itself.
async function fakeAnalyze(text: string): Promise<AnalyzeResponse> {
  const tokens = text
    .split(" ")
    .flatMap((w, i) => [
      ...(i ? [{ surface: " ", lemma: " ", pos: "SPACE", tags: [], is_space: true }] : []),
      { surface: w, lemma: w, pos: "NOUN", tags: [], is_space: false },
    ]);
  return { sentences: [{ tokens }] };
}

const PREMISE = { title: "Il gatto", genre: "giallo", hook: "Un gatto scompare." };

function fakeProvider(beats: number, drafts: (string | Error)[] = []) {
  const outline: StoryOutline = {
    plot: "Trama",
    characters: ["Ala"],
    beats: Array.from({ length: beats }, (_, i) => `beat ${i + 1}`),
  };
  return {
    name: "stub" as const,
    calls: { premises: 0, outline: 0, episode: 0 },
    episodeRequests: [] as EpisodeRequest[],
    async premises() {
      this.calls.premises++;
      return [PREMISE, PREMISE, PREMISE];
    },
    async outline() {
      this.calls.outline++;
      return outline;
    },
    async episode(req: EpisodeRequest) {
      this.calls.episode++;
      this.episodeRequests.push(req);
      const next = drafts.shift() ?? draft(2, `e${req.episodeNumber}`);
      if (next instanceof Error) throw next;
      return next;
    },
    async proofread() {
      return [];
    },
    async correct(text: string) {
      return text;
    },
  } satisfies StoryProvider & { calls: Record<string, number>; episodeRequests: EpisodeRequest[] };
}

function setup(beats = 3, drafts: (string | Error)[] = []) {
  const db = freshDb();
  seedKnown(db);
  const provider = fakeProvider(beats, drafts);
  const svc = storyService(db, { provider, analyze: fakeAnalyze, mweHeadwords: new Map() });
  return { db, provider, svc };
}

test("premises come from the provider, not persisted", async () => {
  const { db, provider, svc } = setup();
  expect(await svc.proposePremises()).toHaveLength(3);
  expect(provider.calls.premises).toBe(1);
  expect(db.select().from(schema.story).all()).toHaveLength(0);
});

test("starting a story persists it and episode 1 as an imported text", async () => {
  const { db, provider, svc } = setup(3);
  const ep = await svc.startStory(PREMISE);

  expect(ep).toMatchObject({ title: "Il gatto", episodeNumber: 1, totalEpisodes: 3 });
  const [story] = db.select().from(schema.story).all();
  expect(story).toMatchObject({ status: "active", plannedEpisodes: 3, title: "Il gatto" });
  const [text] = db.select().from(schema.sourceText).all();
  expect(text).toMatchObject({ id: ep?.textId, storyId: story.id, episodeNumber: 1 });
  expect(db.select().from(schema.token).all().length).toBeGreaterThan(0);
  expect(provider.calls).toMatchObject({ outline: 1, episode: 1 });
  expect(provider.episodeRequests[0].knownLemmas).toEqual(expect.arrayContaining(KNOWN));
});

test("planned episode count is clamped to 10", async () => {
  const { db, svc } = setup(14);
  await svc.startStory(PREMISE);
  expect(db.select().from(schema.story).all()[0].plannedEpisodes).toBe(10);
});

test("a draft far off the level is regenerated; one within range is accepted", async () => {
  const { db, provider, svc } = setup(3, [draft(9), draft(2, "b")]); // 31% new, then 9%
  await svc.startStory(PREMISE);
  expect(provider.calls.episode).toBe(2);
  expect(db.select().from(schema.sourceText).all()[0].content).toBe(draft(2, "b"));
});

test("after 2 retries the closest draft is accepted", async () => {
  const { db, provider, svc } = setup(3, [draft(15), draft(8), draft(12)]); // 43%, 29%, 38%
  await svc.startStory(PREMISE);
  expect(provider.calls.episode).toBe(3);
  expect(db.select().from(schema.sourceText).all()[0].content).toBe(draft(8));
});

test("marking an episode read records the day, sets read_at and prepares the next", async () => {
  const { db, provider, svc } = setup(3);
  const ep1 = (await svc.startStory(PREMISE))!;

  const res = await svc.markEpisodeRead(ep1.textId);
  expect(res).toMatchObject({ storyFinished: false, dayCompleted: false });
  expect(res.line).toMatch(/^\+\d+ parol/);
  expect(db.select().from(schema.dailyActivity).all()).toMatchObject([{ kind: "episode" }]);
  expect(db.select().from(schema.sourceText).all()[0].readAt).toBeInstanceOf(Date);

  const ep2 = await svc.currentEpisode(); // waits on the background generation
  expect(ep2).toMatchObject({ episodeNumber: 2 });
  expect(provider.calls.episode).toBe(2);
  expect(provider.episodeRequests[1].previous).toEqual([ep1.content]);

  // Read twice: nothing new happens.
  await svc.markEpisodeRead(ep1.textId);
  expect(await svc.currentEpisode()).toMatchObject({ episodeNumber: 2 });
  expect(provider.calls.episode).toBe(2);
});

test("the planned last episode finishes the story", async () => {
  const { db, provider, svc } = setup(1);
  const ep1 = (await svc.startStory(PREMISE))!;
  const res = await svc.markEpisodeRead(ep1.textId);
  expect(res.storyFinished).toBe(true);
  expect(db.select().from(schema.story).all()[0].status).toBe("finished");
  expect(await svc.currentEpisode()).toBeNull();
  expect(provider.calls.episode).toBe(1);
  expect((await svc.markEpisodeRead(ep1.textId)).storyFinished).toBe(false); // reread
});

test("reading the last episode of an abandoned story does not finish it", async () => {
  const { db, svc } = setup(1);
  const ep1 = (await svc.startStory(PREMISE))!;
  svc.abandonStory();
  expect((await svc.markEpisodeRead(ep1.textId)).storyFinished).toBe(false);
  expect(db.select().from(schema.story).all()[0].status).toBe("abandoned");
});

test("a failed background generation is retried when the episode is asked for", async () => {
  const { provider, svc } = setup(3, [draft(2), new Error("LLM down")]);
  const ep1 = (await svc.startStory(PREMISE))!;
  await svc.markEpisodeRead(ep1.textId);
  expect(await svc.currentEpisode()).toMatchObject({ episodeNumber: 2 });
  expect(provider.calls.episode).toBe(3);
});

test("one active story at a time; abandoning keeps its episodes as texts", async () => {
  const { db, svc } = setup(3);
  await svc.startStory(PREMISE);
  await expect(svc.startStory(PREMISE)).rejects.toThrow(/active/);

  svc.abandonStory();
  expect(db.select().from(schema.story).all()[0].status).toBe("abandoned");
  expect(await svc.currentEpisode()).toBeNull();
  expect(db.select().from(schema.sourceText).all()).toHaveLength(1);

  await svc.startStory(PREMISE);
  expect(
    db
      .select()
      .from(schema.story)
      .all()
      .map((s) => s.status),
  ).toEqual(["abandoned", "active"]);
});

function seedDictionary(db: DB, words: string[]) {
  for (const word of words) {
    const [{ id }] = db
      .insert(schema.dictEntry)
      .values({ word, pos: "noun" })
      .returning({ id: schema.dictEntry.id })
      .all();
    db.insert(schema.dictForm).values({ entryId: id, form: word, tags: [] }).run();
  }
}

// draft(2) with a non-Polish word; the dictionary has every other word.
function tortaSetup() {
  const db = freshDb();
  seedKnown(db);
  seedDictionary(db, [...KNOWN, "nowea0", "nowea1"]);
  const provider = new StubProvider();
  provider.outline = async () => ({ plot: "p", characters: [], beats: ["b1", "b2"] });
  provider.episode = async () => `${draft(2)} torta`;
  return { db, provider };
}

test("a drafted episode with a non-Polish word is stored corrected", async () => {
  const { db, provider } = tortaSetup();
  const correct = vi.spyOn(provider, "correct");
  const svc = storyService(db, { provider, analyze: fakeAnalyze, mweHeadwords: new Map() });
  const ep = await svc.startStory(PREMISE);

  expect(correct).toHaveBeenCalledTimes(1);
  expect(ep?.content).toBe(draft(2));
  const surfaces = db
    .select()
    .from(schema.token)
    .all()
    .map((t) => t.surface);
  expect(surfaces).not.toContain("torta");
});

test("a clean episode makes one proofread call and no correction", async () => {
  const { db, provider } = tortaSetup();
  provider.episode = async () => draft(2);
  const proofread = vi.spyOn(provider, "proofread");
  const correct = vi.spyOn(provider, "correct");
  await storyService(db, { provider, analyze: fakeAnalyze, mweHeadwords: new Map() }).startStory(
    PREMISE,
  );
  expect(proofread).toHaveBeenCalledTimes(1);
  expect(correct).not.toHaveBeenCalled();
});

test("an episode still flagged after correction stores nothing", async () => {
  const { db, provider } = tortaSetup();
  provider.correct = async (text) => text;
  const svc = storyService(db, { provider, analyze: fakeAnalyze, mweHeadwords: new Map() });
  await expect(svc.startStory(PREMISE)).rejects.toThrow(/"stub".*«torta»/);
  expect(db.select().from(schema.sourceText).all()).toEqual([]);
});

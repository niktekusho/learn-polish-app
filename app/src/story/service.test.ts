import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import { initialKnowledgeFields } from "#/fsrs/index";
import type { AnalyzeResponse } from "#/import/sidecar";
import { callsNamed, type FakeLlm, fakeLlm } from "#/llm/fake";
import type { CorrectionRequest } from "#/proofread/llm";
import type { EpisodeRequest, StoryOutline } from "./llm";
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

// The story LLM: an outline of `beats` episodes, and `drafts` in order (an Error throws).
function storyLlm(beats: number, drafts: (string | Error)[] = []) {
  const outline: StoryOutline = {
    plot: "Trama",
    characters: ["Ala"],
    beats: Array.from({ length: beats }, (_, i) => `beat ${i + 1}`),
  };
  return fakeLlm({
    answers: {
      premises: () => [PREMISE, PREMISE, PREMISE],
      outline: () => outline,
      episode: (req: EpisodeRequest) => {
        const next = drafts.shift() ?? draft(3, `e${req.episodeNumber}`);
        if (next instanceof Error) throw next;
        return next;
      },
    },
  });
}

const episodeRequests = (llm: FakeLlm) =>
  callsNamed(llm, "episode").map((c) => c.req as EpisodeRequest);

function setup(beats = 3, drafts: (string | Error)[] = []) {
  const db = freshDb();
  seedKnown(db);
  const llm = storyLlm(beats, drafts);
  const svc = storyService(db, { llm, analyze: fakeAnalyze, mweHeadwords: new Map() });
  return { db, llm, svc };
}

test("premises come from the LLM, not persisted", async () => {
  const { db, llm, svc } = setup();
  expect(await svc.proposePremises()).toHaveLength(3);
  expect(callsNamed(llm, "premises")).toHaveLength(1);
  expect(db.select().from(schema.story).all()).toHaveLength(0);
});

test("premises are asked to avoid the genres of stories already ended", async () => {
  const { db, llm, svc } = setup();
  const row = {
    hook: "h",
    outline: { plot: "p", characters: [], beats: ["b"] },
    plannedEpisodes: 1,
  };
  db.insert(schema.story)
    .values([
      { ...row, title: "a", genre: "giallo", status: "finished" },
      { ...row, title: "b", genre: "giallo", status: "abandoned" },
      { ...row, title: "c", genre: "fantasy", status: "active" },
    ])
    .run();
  await svc.proposePremises();
  expect(callsNamed(llm, "premises").map((c) => c.req)).toEqual([["giallo"]]);
});

test("starting a story persists it and episode 1 as an imported text", async () => {
  const { db, llm, svc } = setup(3);
  const ep = await svc.startStory(PREMISE);

  expect(ep).toMatchObject({ title: "Il gatto", episodeNumber: 1, totalEpisodes: 3 });
  const [story] = db.select().from(schema.story).all();
  expect(story).toMatchObject({ status: "active", plannedEpisodes: 3, title: "Il gatto" });
  const [text] = db.select().from(schema.sourceText).all();
  expect(text).toMatchObject({ id: ep?.textId, storyId: story.id, episodeNumber: 1 });
  expect(db.select().from(schema.token).all().length).toBeGreaterThan(0);
  expect(callsNamed(llm, "outline")).toHaveLength(1);
  expect(episodeRequests(llm)).toHaveLength(1);
  expect(episodeRequests(llm)[0]).toMatchObject({ newShare: 0.15, feedback: undefined });
});

test("planned episode count is clamped to 10", async () => {
  const { db, svc } = setup(14);
  await svc.startStory(PREMISE);
  expect(db.select().from(schema.story).all()[0].plannedEpisodes).toBe(10);
});

test("a draft far off the level is regenerated; one within range is accepted", async () => {
  const { db, llm, svc } = setup(3, [draft(9), draft(3, "b")]); // 31% new, then 13%
  await svc.startStory(PREMISE);
  expect(callsNamed(llm, "episode")).toHaveLength(2);
  expect(db.select().from(schema.sourceText).all()[0].content).toBe(draft(3, "b"));
});

test("a redraft is told the level of the rejected draft", async () => {
  const { llm, svc } = setup(3, [draft(9), draft(3, "b")]);
  await svc.startStory(PREMISE);
  const [, retry] = episodeRequests(llm);
  expect(retry.feedback?.share).toBeCloseTo(9 / 29);
  expect(retry.feedback?.newWords).toHaveLength(9);
});

test("after 2 retries the closest draft is accepted", async () => {
  const { db, llm, svc } = setup(3, [draft(15), draft(8), draft(12)]); // 43%, 29%, 38%
  await svc.startStory(PREMISE);
  expect(callsNamed(llm, "episode")).toHaveLength(3);
  expect(db.select().from(schema.sourceText).all()[0].content).toBe(draft(8));
});

test("marking an episode read records the day, sets read_at and prepares the next", async () => {
  const { db, llm, svc } = setup(3);
  const ep1 = (await svc.startStory(PREMISE))!;

  const res = await svc.markEpisodeRead(ep1.textId);
  expect(res).toMatchObject({ storyFinished: false, dayCompleted: false });
  expect(res.line).toMatch(/^\+\d+ parol/);
  expect(db.select().from(schema.dailyActivity).all()).toMatchObject([{ kind: "episode" }]);
  expect(db.select().from(schema.sourceText).all()[0].readAt).toBeInstanceOf(Date);

  const ep2 = await svc.currentEpisode(); // waits on the background generation
  expect(ep2).toMatchObject({ episodeNumber: 2 });
  expect(callsNamed(llm, "episode")).toHaveLength(2);
  expect(episodeRequests(llm)[1].previous).toBe(ep1.content);

  // Read twice: nothing new happens.
  await svc.markEpisodeRead(ep1.textId);
  expect(await svc.currentEpisode()).toMatchObject({ episodeNumber: 2 });
  expect(callsNamed(llm, "episode")).toHaveLength(2);
});

test("the active story names its next episode: the first unread, generated or not", async () => {
  const { svc } = setup(3);
  const ep1 = (await svc.startStory(PREMISE))!;
  expect(svc.activeStory()?.nextEpisode).toBe(1);

  await svc.markEpisodeRead(ep1.textId);
  expect(svc.activeStory()?.nextEpisode).toBe(2);
});

test("an episode shows its outline beat as a summary only once read", async () => {
  const { db, svc } = setup(3);
  const ep1 = (await svc.startStory(PREMISE))!;
  db.update(schema.story)
    .set({
      outline: { plot: "", characters: [], beats: ["episodio 1: Ala trova un gatto.", "b2", "b3"] },
    })
    .run();
  expect(svc.activeStory()?.episodes[0]).toMatchObject({ readAt: null, summary: null });

  await svc.markEpisodeRead(ep1.textId);
  await svc.currentEpisode();
  const [first, second] = svc.activeStory()!.episodes;
  expect(first).toMatchObject({ summary: "Ala trova un gatto.", words: 23 });
  expect(first.readAt).not.toBeNull();
  expect(second).toMatchObject({ readAt: null, summary: null });
});

test("the planned last episode finishes the story", async () => {
  const { db, llm, svc } = setup(1);
  const ep1 = (await svc.startStory(PREMISE))!;
  const res = await svc.markEpisodeRead(ep1.textId);
  expect(res.storyFinished).toBe(true);
  expect(db.select().from(schema.story).all()[0].status).toBe("finished");
  expect(await svc.currentEpisode()).toBeNull();
  expect(callsNamed(llm, "episode")).toHaveLength(1);
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
  const { llm, svc } = setup(3, [draft(3), new Error("LLM down")]);
  const ep1 = (await svc.startStory(PREMISE))!;
  await svc.markEpisodeRead(ep1.textId);
  expect(await svc.currentEpisode()).toMatchObject({ episodeNumber: 2 });
  expect(callsNamed(llm, "episode")).toHaveLength(3);
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

// draft(3) with a non-Polish word; the dictionary has every other word.
function tortaSetup(
  episode = `${draft(3)} torta`,
  answers: Record<string, (req: any) => unknown> = {},
) {
  const db = freshDb();
  seedKnown(db);
  seedDictionary(db, [...KNOWN, "nowea0", "nowea1", "nowea2"]);
  const llm = fakeLlm({
    answers: {
      outline: () => ({ plot: "p", characters: [], beats: ["b1", "b2"] }),
      episode: () => episode,
      ...answers,
    },
  });
  const svc = storyService(db, { llm, analyze: fakeAnalyze, mweHeadwords: new Map() });
  return { db, llm, svc };
}

test("a drafted episode with a non-Polish word is stored corrected", async () => {
  const { db, llm, svc } = tortaSetup();
  const ep = await svc.startStory(PREMISE);

  expect(callsNamed(llm, "correction")).toHaveLength(1);
  expect(ep?.content).toBe(draft(3));
  const surfaces = db
    .select()
    .from(schema.token)
    .all()
    .map((t) => t.surface);
  expect(surfaces).not.toContain("torta");
});

test("a clean episode makes one proofread call and no correction", async () => {
  const { llm, svc } = tortaSetup(draft(3));
  await svc.startStory(PREMISE);
  expect(callsNamed(llm, "proofread")).toHaveLength(1);
  expect(callsNamed(llm, "correction")).toHaveLength(0);
});

test("an episode still flagged after correction stores nothing", async () => {
  const { db, svc } = tortaSetup(undefined, {
    correction: (req: CorrectionRequest) => req.text,
  });
  await expect(svc.startStory(PREMISE)).rejects.toThrow(/"stub".*«torta»/);
  expect(db.select().from(schema.sourceText).all()).toEqual([]);
});

test("the first read of an episode, and only the first, starts preparing its Conversation", async () => {
  const db = freshDb();
  seedKnown(db);
  const read: number[] = [];
  const svc = storyService(db, {
    llm: storyLlm(3),
    analyze: fakeAnalyze,
    mweHeadwords: new Map(),
    onEpisodeRead: (textId) => read.push(textId),
  });
  const ep1 = (await svc.startStory(PREMISE))!;
  await svc.markEpisodeRead(ep1.textId);
  await svc.markEpisodeRead(ep1.textId);
  expect(read).toEqual([ep1.textId]);
});

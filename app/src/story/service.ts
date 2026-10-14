import { and, asc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "#/db/schema";
import { sourceText, story } from "#/db/schema";
import { knownLemmas } from "#/fsrs/index";
import { persistAnalysis } from "#/import/pipeline";
import type { AnalyzeResponse } from "#/import/sidecar";
import type { GlossProvider, StoryPremise } from "#/llm/provider";
import { episodeLine, recordActivity } from "#/recap/service";

type DB = BetterSQLite3Database<typeof schema>;
type StoryRow = typeof story.$inferSelect;

export const MAX_EPISODES = 10;
// Share of an episode's content lemmas missing from the store.
export const NEW_SHARE_TARGET = 0.1;
export const NEW_SHARE_MIN = 0.05;
export const NEW_SHARE_MAX = 0.15;
export const LEVEL_RETRIES = 2;
const CONTENT_POS = new Set(["NOUN", "VERB", "ADJ", "ADV"]);

export interface StoryDeps {
  provider: GlossProvider;
  analyze: (text: string) => Promise<AnalyzeResponse>;
  mweHeadwords?: Map<string, string[]>; // tests skip the dictionary lookup
}

export interface Episode {
  storyId: number;
  title: string;
  textId: number;
  episodeNumber: number;
  totalEpisodes: number;
  content: string;
}

export interface ReadResult {
  line: string;
  storyFinished: boolean;
  dayCompleted: boolean; // this read completed the day (both items done)
}

// Episode generations in flight, per DB, keyed "storyId:episodeNumber": the
// reader waits on a running background generation instead of starting another.
const inFlight = new WeakMap<DB, Map<string, Promise<void>>>();

function capability<K extends "storyPremises" | "storyOutline" | "storyEpisode">(
  provider: GlossProvider,
  key: K,
): NonNullable<GlossProvider[K]> {
  const fn = provider[key];
  if (!fn) throw new Error(`provider "${provider.name}" does not support stories`);
  return fn.bind(provider) as NonNullable<GlossProvider[K]>;
}

/** Fraction of distinct content lemmas in `analysis` that are not in `known`. */
function newShare(analysis: AnalyzeResponse, known: Set<string>): number {
  const lemmas = new Set(
    analysis.sentences.flatMap((s) =>
      s.tokens.filter((t) => CONTENT_POS.has(t.pos)).map((t) => t.lemma.toLowerCase()),
    ),
  );
  if (lemmas.size === 0) return 0;
  return [...lemmas].filter((l) => !known.has(l)).length / lemmas.size;
}

/** The Story seam: provider and analyzer injected so tests use fakes. */
export function storyService(db: DB, deps: StoryDeps) {
  const running = inFlight.get(db) ?? new Map<string, Promise<void>>();
  inFlight.set(db, running);

  function activeStory(): StoryRow | undefined {
    return db.select().from(story).where(eq(story.status, "active")).all()[0];
  }

  function episodes(storyId: number) {
    return db
      .select()
      .from(sourceText)
      .where(eq(sourceText.storyId, storyId))
      .orderBy(asc(sourceText.episodeNumber))
      .all();
  }

  /**
   * Write episode `n`: draft, analyze, accept when the new-lemma share is in
   * range, else redraft (LEVEL_RETRIES times) and keep the closest draft.
   */
  async function generateEpisode(s: StoryRow, n: number): Promise<void> {
    const known = knownLemmas(db);
    const knownSet = new Set(known.map((l) => l.toLowerCase()));
    const req = {
      premise: { title: s.title, genre: s.genre, hook: s.hook },
      outline: s.outline,
      previous: episodes(s.id)
        .filter((e) => (e.episodeNumber ?? 0) < n)
        .map((e) => e.content),
      episodeNumber: n,
      totalEpisodes: s.plannedEpisodes,
      knownLemmas: known,
    };
    const write = capability(deps.provider, "storyEpisode");
    let best: { text: string; analysis: AnalyzeResponse; miss: number } | undefined;
    for (let attempt = 0; attempt <= LEVEL_RETRIES; attempt++) {
      const text = await write(req);
      const analysis = await deps.analyze(text);
      const share = newShare(analysis, knownSet);
      const miss = Math.abs(share - NEW_SHARE_TARGET);
      if (!best || miss < best.miss) best = { text, analysis, miss };
      if (share >= NEW_SHARE_MIN && share <= NEW_SHARE_MAX) break;
    }
    const chosen = best as NonNullable<typeof best>;
    persistAnalysis(
      db,
      {
        title: `${s.title} · episodio ${n}`,
        content: chosen.text,
        storyId: s.id,
        episodeNumber: n,
      },
      chosen.analysis,
      new Date(),
      deps.mweHeadwords,
    );
  }

  /** Generate episode `n` unless it exists or is already being generated. */
  function ensureEpisode(s: StoryRow, n: number): Promise<void> {
    const key = `${s.id}:${n}`;
    const pending = running.get(key);
    if (pending) return pending;
    if (episodes(s.id).some((e) => e.episodeNumber === n)) return Promise.resolve();
    const job = generateEpisode(s, n).finally(() => running.delete(key));
    running.set(key, job);
    return job;
  }

  function toEpisode(s: StoryRow, e: typeof sourceText.$inferSelect): Episode {
    return {
      storyId: s.id,
      title: s.title,
      textId: e.id,
      episodeNumber: e.episodeNumber as number,
      totalEpisodes: s.plannedEpisodes,
      content: e.content,
    };
  }

  /**
   * The active story's unread episode. Missing (a background generation
   * failed or is still running): wait for it or generate it now.
   * null when there is no active story.
   */
  async function currentEpisode(): Promise<Episode | null> {
    const s = activeStory();
    if (!s) return null;
    const unread = () => episodes(s.id).find((e) => e.readAt === null);
    let e = unread();
    if (!e) {
      const last = episodes(s.id).at(-1)?.episodeNumber ?? 0;
      if (last >= s.plannedEpisodes) return null;
      // A failed background run is retried here, with the learner waiting.
      await running.get(`${s.id}:${last + 1}`)?.catch(() => {});
      await ensureEpisode(s, last + 1);
      e = unread();
    }
    return e ? toEpisode(s, e) : null;
  }

  return {
    async proposePremises(): Promise<StoryPremise[]> {
      return capability(deps.provider, "storyPremises")();
    },

    /** Outline the story, persist it, and write episode 1 (the one visible wait). */
    async startStory(premise: StoryPremise): Promise<Episode | null> {
      if (activeStory()) throw new Error("a story is already active");
      const outline = await capability(deps.provider, "storyOutline")(premise);
      const planned = Math.min(MAX_EPISODES, outline.beats.length);
      const [s] = db
        .insert(story)
        .values({
          ...premise,
          outline: { ...outline, beats: outline.beats.slice(0, planned) },
          plannedEpisodes: planned,
          status: "active",
        })
        .returning()
        .all();
      await ensureEpisode(s, 1);
      return currentEpisode();
    },

    currentEpisode,

    /**
     * First read of an episode: set read_at, count the day's Episode, then
     * write the next one in the background, or finish the story after the
     * planned last. A repeat read only returns the note.
     */
    async markEpisodeRead(textId: number, now = new Date()): Promise<ReadResult> {
      const [t] = db.select().from(sourceText).where(eq(sourceText.id, textId)).all();
      if (!t?.storyId || !t.episodeNumber) throw new Error(`text ${textId} is not an episode`);
      const [s] = db.select().from(story).where(eq(story.id, t.storyId)).all();
      const line = episodeLine(db, textId);
      const isLast = t.episodeNumber >= s.plannedEpisodes;
      if (t.readAt) return { line, storyFinished: false, dayCompleted: false };

      db.update(sourceText).set({ readAt: now }).where(eq(sourceText.id, textId)).run();
      const { inserted, complete } = recordActivity(db, "episode", now);
      if (isLast) {
        db.update(story)
          .set({ status: "finished", endedAt: now })
          .where(and(eq(story.id, s.id), eq(story.status, "active")))
          .run();
      } else if (s.status === "active") {
        const next = t.episodeNumber + 1;
        ensureEpisode(s, next).catch((err) =>
          console.error(`[story] background episode ${next} failed:`, err),
        );
      }
      return {
        line,
        storyFinished: isLast && s.status === "active",
        dayCompleted: inserted && complete,
      };
    },

    /** End the active story; its episodes stay readable as texts. */
    abandonStory(now = new Date()): void {
      db.update(story)
        .set({ status: "abandoned", endedAt: now })
        .where(eq(story.status, "active"))
        .run();
    },

    /** The active story with its episodes, for the story page. */
    activeStory() {
      const s = activeStory();
      if (!s) return null;
      return {
        id: s.id,
        title: s.title,
        genre: s.genre,
        hook: s.hook,
        totalEpisodes: s.plannedEpisodes,
        episodes: episodes(s.id).map((e) => ({
          textId: e.id,
          episodeNumber: e.episodeNumber as number,
          read: e.readAt !== null,
        })),
      };
    },
  };
}

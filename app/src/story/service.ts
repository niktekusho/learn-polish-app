import { and, asc, eq, ne } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "#/db/schema";
import { sourceText, story } from "#/db/schema";
import { knownLemmas } from "#/fsrs/index";
import { importAnalysis } from "#/import/checked-import";
import type { AnalyzeResponse } from "#/import/sidecar";
import type { Llm } from "#/llm/call";
import { proofreadText } from "#/proofread/proofread";
import { episodeLine, newLemmaCount, recordActivity, wordCount } from "#/recap/service";
import {
  beatText,
  episode,
  type EpisodeRequest,
  type LevelFeedback,
  outline,
  premises,
  type StoryPremise,
} from "./llm";
import { levelOf } from "./metrics";

type DB = BetterSQLite3Database<typeof schema>;
type StoryRow = typeof story.$inferSelect;

export const MAX_EPISODES = 10;
// Share of an episode's content lemmas missing from the store.
export const NEW_SHARE_TARGET = 0.15;
export const NEW_SHARE_MIN = 0.1;
export const NEW_SHARE_MAX = 0.2;
export const LEVEL_RETRIES = 2;

export const inLevelRange = (share: number) => share >= NEW_SHARE_MIN && share <= NEW_SHARE_MAX;

export interface StoryDeps {
  llm: Llm;
  analyze: (text: string) => Promise<AnalyzeResponse>;
  mweHeadwords?: Map<string, string[]>; // tests skip the dictionary lookup
  // Called on an Episode's first read: the Conversation that follows it is prepared here.
  onEpisodeRead?: (textId: number) => void;
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

export interface WrittenEpisode {
  draft: string; // the chosen draft, before the Proofread
  text: string; // proofread and corrected
  analysis: AnalyzeResponse; // of `text`
  drafts: number;
  rounds: number; // Corrections the Proofread took
}

/**
 * Draft an episode, analyze it, accept it when the new-lemma share is in range,
 * else redraft with that draft's level (LEVEL_RETRIES times) and keep the
 * closest draft, then proofread and correct it (ADR-0009).
 */
export async function writeEpisode(
  db: DB,
  deps: Pick<StoryDeps, "llm" | "analyze">,
  req: Omit<EpisodeRequest, "newShare" | "feedback">,
): Promise<WrittenEpisode> {
  const knownSet = new Set(knownLemmas(db).map((l) => l.toLowerCase()));
  let best: { text: string; analysis: AnalyzeResponse; miss: number } | undefined;
  let feedback: LevelFeedback | undefined;
  let drafts = 0;
  for (let attempt = 0; attempt <= LEVEL_RETRIES; attempt++) {
    const text = await deps.llm.call(episode, { ...req, newShare: NEW_SHARE_TARGET, feedback });
    drafts++;
    const analysis = await deps.analyze(text);
    const level = levelOf(analysis, knownSet);
    const miss = Math.abs(level.share - NEW_SHARE_TARGET);
    if (!best || miss < best.miss) best = { text, analysis, miss };
    if (inLevelRange(level.share)) break;
    feedback = level;
  }
  const chosen = best as NonNullable<typeof best>;
  const checked = await proofreadText(db, deps, chosen.text, chosen.analysis);
  return {
    draft: chosen.text,
    text: checked.text,
    analysis: checked.analysis,
    drafts,
    rounds: checked.rounds,
  };
}

// Episode generations in flight, per DB, keyed "storyId:episodeNumber": the
// reader waits on a running background generation instead of starting another.
const inFlight = new WeakMap<DB, Map<string, Promise<void>>>();

/** The Story seam: LLM and analyzer injected so tests use fakes. */
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

  /** Write episode `n` and import it. */
  async function generateEpisode(s: StoryRow, n: number): Promise<void> {
    const previous = episodes(s.id).find((e) => e.episodeNumber === n - 1);
    const checked = await writeEpisode(db, deps, {
      premise: { title: s.title, genre: s.genre, hook: s.hook },
      outline: s.outline,
      previous: previous?.content ?? null,
      episodeNumber: n,
      totalEpisodes: s.plannedEpisodes,
    });
    console.info(
      `[story] episode ${n} of story ${s.id}: ${checked.drafts} drafts, ${checked.rounds} corrections`,
    );
    await importAnalysis(
      db,
      deps.llm,
      {
        title: `${s.title} · episodio ${n}`,
        content: checked.text,
        storyId: s.id,
        episodeNumber: n,
      },
      checked.analysis,
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
      const past = db
        .selectDistinct({ genre: story.genre })
        .from(story)
        .where(ne(story.status, "active"))
        .all();
      return deps.llm.call(
        premises,
        past.map((p) => p.genre),
      );
    },

    /** Outline the story, persist it, and write episode 1 (the one visible wait). */
    async startStory(premise: StoryPremise): Promise<Episode | null> {
      if (activeStory()) throw new Error("a story is already active");
      const plan = await deps.llm.call(outline, premise);
      const planned = Math.min(MAX_EPISODES, plan.beats.length);
      const [s] = db
        .insert(story)
        .values({
          ...premise,
          outline: { ...plan, beats: plan.beats.slice(0, planned) },
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
      deps.onEpisodeRead?.(textId);
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
      const all = episodes(s.id);
      return {
        id: s.id,
        title: s.title,
        genre: s.genre,
        hook: s.hook,
        totalEpisodes: s.plannedEpisodes,
        // The next episode may not be generated yet: then it is the one after the last.
        nextEpisode: all.find((e) => e.readAt === null)?.episodeNumber ?? all.length + 1,
        episodes: all.map((e) => {
          const n = e.episodeNumber as number;
          const beat = s.outline.beats[n - 1];
          return {
            textId: e.id,
            episodeNumber: n,
            readAt: e.readAt,
            words: wordCount(db, e.id),
            newWords: newLemmaCount(db, e.id),
            // The outline beat summarizes the episode: shown once read, it spoils nothing.
            summary: e.readAt ? (beat === undefined ? null : beatText(beat)) : null,
          };
        }),
      };
    },
  };
}

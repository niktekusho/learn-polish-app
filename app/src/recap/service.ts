import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lt,
  min,
  ne,
  notExists,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "#/db/schema";
import {
  conversation,
  dailyActivity,
  gloss,
  lemma,
  reviewLog,
  sourceText,
  story,
  token,
} from "#/db/schema";
import { heardLineCount } from "#/conversation/heard-lines";
import { MATURE_DAYS, type Track, startOfDay } from "#/fsrs/index";
import { NAME_POS } from "#/reader/name";
import { plural } from "#/plural";

type DB = BetterSQLite3Database<typeof schema>;
/** The daily routine is Practice plus one item: Episodes and Conversations alternate by day. */
export type RoutineItem = "episode" | "conversation";
export type ActivityKind = "practice" | RoutineItem;

const EXAMPLES = 3;
/** Turns a Conversation needs before its Debrief counts for the daily. */
export const DAILY_TURNS = 3;

/** A word shown in the recap: the track that moved it today and its lemma gloss. */
export interface RecapWord {
  lemma: string;
  track: Track;
  italian: string | null;
}

export interface Recap {
  newWords: number;
  stronger: { count: number; examples: RecapWord[] };
  matured: { count: number; examples: RecapWord[] };
  streak: number;
  practiceDone: boolean;
  item: RoutineItem; // the day's item after Practice
  itemDone: boolean;
  complete: boolean; // giornata completa: Practice and the day's item done
  conversation: { heardLines: number } | null; // the last Conversation debriefed today
  // A Conversation debriefed today too short to count: it stays the day's item until tomorrow.
  shortConversation: { turns: number; needed: number } | null;
}

/** Local calendar day as YYYY-MM-DD. */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/**
 * Mark a daily item done. Idempotent per (day, kind). `inserted` is true only
 * for the first write of the day; with `complete` it tells the caller this
 * action completed the day.
 */
export function recordActivity(
  db: DB,
  kind: ActivityKind,
  now = new Date(),
): { inserted: boolean; complete: boolean } {
  const day = localDay(now);
  const inserted = db.insert(dailyActivity).values({ day, kind }).onConflictDoNothing().run();
  const done = kindsDone(db, day);
  return { inserted: inserted.changes > 0, complete: isComplete(done, dayItem(db, done, now)) };
}

const isComplete = (done: Set<ActivityKind>, item: RoutineItem) =>
  done.has("practice") && done.has(item);

/**
 * The day's item: the one done today, else the current Conversation until it is debriefed.
 * A Debrief too short to count keeps the Conversation as the day's item until tomorrow.
 */
function dayItem(db: DB, done: Set<ActivityKind>, now: Date): RoutineItem {
  if (done.has("episode")) return "episode";
  if (done.has("conversation")) return "conversation";
  const episodeId = conversationEpisode(db);
  if (episodeId === null) return "episode";
  const c = db
    .select({ status: conversation.status, updatedAt: conversation.updatedAt })
    .from(conversation)
    .where(eq(conversation.episodeId, episodeId))
    .get();
  if (c?.status !== "debriefed") return "conversation";
  return c.updatedAt >= startOfDay(now) ? "conversation" : "episode";
}

/**
 * The Episode whose Conversation is current: a started, open Conversation, so reading a newer
 * Episode never abandons one, else the last Episode read in a Story not abandoned.
 */
export function conversationEpisode(db: DB): number | null {
  const started = db
    .select({ episodeId: conversation.episodeId })
    .from(conversation)
    .where(and(eq(conversation.status, "open"), gt(conversation.turnCount, 0)))
    .orderBy(desc(conversation.updatedAt), desc(conversation.id))
    .get();
  if (started) return started.episodeId;
  const read = db
    .select({ id: sourceText.id })
    .from(sourceText)
    .innerJoin(story, eq(story.id, sourceText.storyId))
    .where(and(isNotNull(sourceText.readAt), ne(story.status, "abandoned")))
    .orderBy(desc(sourceText.readAt), desc(sourceText.id))
    .get();
  return read?.id ?? null;
}

function kindsDone(db: DB, day: string): Set<ActivityKind> {
  return new Set(
    db
      .select({ kind: dailyActivity.kind })
      .from(dailyActivity)
      .where(eq(dailyActivity.day, day))
      .all()
      .map((r) => r.kind),
  );
}

/** Consecutive active days ending today, or yesterday while today is still empty. */
function streak(db: DB, now: Date): number {
  const days = new Set(
    db
      .selectDistinct({ day: dailyActivity.day })
      .from(dailyActivity)
      .orderBy(desc(dailyActivity.day))
      .all()
      .map((r) => r.day),
  );
  let cursor = days.has(localDay(now)) ? now : addDays(now, -1);
  let n = 0;
  while (days.has(localDay(cursor))) {
    n++;
    cursor = addDays(cursor, -1);
  }
  return n;
}

/**
 * Review effects from `from` to `to` (open-ended when omitted), optionally
 * limited to some lemmas. Legacy rows (null stabilities) count only as first reviews.
 */
function summarize(db: DB, from: Date, to?: Date, lemmaIds?: number[]) {
  const scope = lemmaIds ? inArray(reviewLog.lemmaId, lemmaIds) : undefined;

  const firsts = db
    .select({ lemmaId: reviewLog.lemmaId, first: min(reviewLog.reviewedAt) })
    .from(reviewLog)
    .where(scope)
    .groupBy(reviewLog.lemmaId)
    .all();
  const newWords = firsts.filter((r) => r.first && r.first >= from && (!to || r.first < to)).length;

  const rows = db
    .select({
      lemmaId: reviewLog.lemmaId,
      lemma: lemma.lemma,
      track: reviewLog.track,
      before: reviewLog.stabilityBefore,
      after: reviewLog.stabilityAfter,
    })
    .from(reviewLog)
    .innerJoin(lemma, eq(lemma.id, reviewLog.lemmaId))
    .where(and(gte(reviewLog.reviewedAt, from), to && lt(reviewLog.reviewedAt, to), scope))
    .orderBy(reviewLog.reviewedAt)
    .all();

  type Moved = { lemmaId: number; lemma: string; track: Track };
  const gain = new Map<number, Moved & { gain: number }>();
  const matured = new Map<number, Moved>();
  for (const r of rows) {
    if (r.before == null || r.after == null) continue;
    const g = r.after - r.before;
    if (g > 0 && g > (gain.get(r.lemmaId)?.gain ?? 0)) gain.set(r.lemmaId, { ...r, gain: g });
    if (r.before < MATURE_DAYS && r.after >= MATURE_DAYS && !matured.has(r.lemmaId)) {
      matured.set(r.lemmaId, r);
    }
  }

  const strongest = [...gain.values()].sort((a, b) => b.gain - a.gain).slice(0, EXAMPLES);
  const italian = lemmaGlosses(
    db,
    [...strongest, ...matured.values()].map((m) => m.lemmaId),
  );
  const word = (m: Moved): RecapWord => ({
    lemma: m.lemma,
    track: m.track,
    italian: italian.get(m.lemmaId) ?? null,
  });
  return {
    newWords,
    stronger: { count: gain.size, examples: strongest.map(word) },
    matured: { count: matured.size, examples: [...matured.values()].map(word) },
  };
}

/** The lemma gloss (the sense='' row) of each lemma that has one. */
function lemmaGlosses(db: DB, lemmaIds: number[]): Map<number, string> {
  if (lemmaIds.length === 0) return new Map();
  return new Map(
    db
      .select({ lemmaId: gloss.lemmaId, italian: gloss.italian })
      .from(gloss)
      .where(and(inArray(gloss.lemmaId, lemmaIds), eq(gloss.sense, "")))
      .all()
      .map((g) => [g.lemmaId, g.italian]),
  );
}

/** The daily recap for `now`'s local day. Derived, nothing stored. */
export function getRecap(db: DB, now = new Date()): Recap {
  const done = kindsDone(db, localDay(now));
  const item = dayItem(db, done, now);
  const from = startOfDay(now);
  return {
    ...summarize(db, from, addDays(from, 1)),
    streak: streak(db, now),
    practiceDone: done.has("practice"),
    item,
    itemDone: done.has(item),
    complete: isComplete(done, item),
    conversation: done.has("conversation")
      ? heardLines(db, debriefedToday(db, from, addDays(from, 1)))
      : null,
    shortConversation: shortConversation(db, done, item, from),
  };
}

function shortConversation(
  db: DB,
  done: Set<ActivityKind>,
  item: RoutineItem,
  from: Date,
): Recap["shortConversation"] {
  if (item !== "conversation" || done.has("conversation")) return null;
  const c = debriefedToday(db, from, addDays(from, 1));
  return c ? { turns: c.turnCount, needed: DAILY_TURNS } : null;
}

function heardLines(db: DB, c: { id: number } | undefined): Recap["conversation"] {
  return c ? { heardLines: heardLineCount(db, c.id) } : null;
}

/** The last Conversation debriefed in [from, to). */
function debriefedToday(db: DB, from: Date, to: Date) {
  // A debriefed Conversation is never written again, so updatedAt is its Debrief time.
  return db
    .select({ id: conversation.id, turnCount: conversation.turnCount })
    .from(conversation)
    .where(
      and(
        eq(conversation.status, "debriefed"),
        gte(conversation.updatedAt, from),
        lt(conversation.updatedAt, to),
      ),
    )
    .orderBy(desc(conversation.updatedAt))
    .get();
}

/** One-line note at the end of a Practice session: its lemmas' reviews since it started. */
export function practiceLine(db: DB, lemmaIds: number[], startedAt: Date): string {
  const s = summarize(db, startedAt, undefined, lemmaIds);
  const parts = [
    `+${s.stronger.count} ${plural(s.stronger.count, "parola più solida", "parole più solide")}`,
  ];
  if (s.matured.count > 0) {
    parts.push(`${s.matured.count} ${plural(s.matured.count, "consolidata", "consolidate")}`);
  }
  return parts.join(" · ");
}

/** A text's word count: its tokens with a lemma, so punctuation is left out. */
export function wordCount(db: DB, textId: number): number {
  const [{ n }] = db
    .select({ n: count(token.lemmaId) })
    .from(token)
    .where(eq(token.textId, textId))
    .all();
  return n;
}

/** One-line note after an Episode: its count of new lemmas. */
export function episodeLine(db: DB, textId: number): string {
  const n = newLemmaCount(db, textId);
  return `+${n} ${plural(n, "parola nuova incontrata", "parole nuove incontrate")}`;
}

/**
 * Lemmas of a text that no earlier text contained, names excluded.
 * ponytail: token lemmas only; MWE occurrences are not counted. A name the
 * analyzer mistags as NOUN still counts.
 */
export function newLemmaCount(db: DB, textId: number): number {
  const earlier = alias(token, "earlier");
  const [{ n }] = db
    .select({ n: countDistinct(token.lemmaId) })
    .from(token)
    .innerJoin(lemma, eq(lemma.id, token.lemmaId))
    .where(
      and(
        eq(token.textId, textId),
        ne(lemma.pos, NAME_POS),
        notExists(
          db
            .select({ id: earlier.id })
            .from(earlier)
            .where(and(eq(earlier.lemmaId, token.lemmaId), lt(earlier.textId, textId))),
        ),
      ),
    )
    .all();
  return n;
}

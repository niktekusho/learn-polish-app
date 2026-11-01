import { and, countDistinct, desc, eq, gte, inArray, lt, min, ne, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "#/db/schema";
import { dailyActivity, gloss, lemma, reviewLog, token } from "#/db/schema";
import { MATURE_DAYS, type Track, startOfDay } from "#/fsrs/index";
import { NAME_POS } from "#/reader/name";

type DB = BetterSQLite3Database<typeof schema>;
export type ActivityKind = "practice" | "episode";

const EXAMPLES = 3;

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
  episodeDone: boolean;
  complete: boolean; // giornata completa: both items done
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
  return { inserted: inserted.changes > 0, complete: kindsDone(db, day).size === 2 };
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
  const from = startOfDay(now);
  return {
    ...summarize(db, from, addDays(from, 1)),
    streak: streak(db, now),
    practiceDone: done.has("practice"),
    episodeDone: done.has("episode"),
    complete: done.size === 2,
  };
}

/** One-line note at the end of a Practice session: its lemmas' reviews since it started. */
export function practiceLine(db: DB, lemmaIds: number[], startedAt: Date): string {
  const s = summarize(db, startedAt, undefined, lemmaIds);
  const parts = [
    `+${s.stronger.count} ${s.stronger.count === 1 ? "parola più solida" : "parole più solide"}`,
  ];
  if (s.matured.count > 0) {
    parts.push(`${s.matured.count} ${s.matured.count === 1 ? "consolidata" : "consolidate"}`);
  }
  return parts.join(" · ");
}

/**
 * One-line note after an Episode: its lemmas no earlier text contained, names excluded.
 * ponytail: token lemmas only; MWE occurrences are not counted. A name the
 * analyzer mistags as NOUN still counts.
 */
export function episodeLine(db: DB, textId: number): string {
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
  return `+${n} ${n === 1 ? "parola nuova incontrata" : "parole nuove incontrate"}`;
}

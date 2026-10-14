import {
  and,
  countDistinct,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  min,
  notExists,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "#/db/schema";
import { dailyActivity, lemma, reviewLog, token } from "#/db/schema";
import { startOfDay } from "#/fsrs/index";

type DB = BetterSQLite3Database<typeof schema>;
export type ActivityKind = "practice" | "episode";

/** CONTEXT.md "Mature": stability of 21 days on a track. */
const MATURE_DAYS = 21;
const EXAMPLES = 3;

export interface Recap {
  newWords: number;
  stronger: { count: number; examples: string[] };
  matured: { count: number; examples: string[] };
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
 * Review effects on `now`'s local day, optionally limited to some lemmas.
 * Legacy review rows (null stabilities) count only toward first-review detection.
 */
function summarize(db: DB, now: Date, lemmaIds?: number[]) {
  const from = startOfDay(now);
  const to = addDays(from, 1);
  const scope = lemmaIds ? inArray(reviewLog.lemmaId, lemmaIds) : undefined;

  const firsts = db
    .select({ lemmaId: reviewLog.lemmaId, first: min(reviewLog.reviewedAt) })
    .from(reviewLog)
    .where(scope)
    .groupBy(reviewLog.lemmaId)
    .all();
  const newWords = firsts.filter((r) => r.first && r.first >= from && r.first < to).length;

  const rows = db
    .select({
      lemmaId: reviewLog.lemmaId,
      lemma: lemma.lemma,
      before: reviewLog.stabilityBefore,
      after: reviewLog.stabilityAfter,
    })
    .from(reviewLog)
    .innerJoin(lemma, eq(lemma.id, reviewLog.lemmaId))
    .where(and(gte(reviewLog.reviewedAt, from), lt(reviewLog.reviewedAt, to), scope))
    .all();

  const gain = new Map<number, { lemma: string; gain: number }>();
  const matured = new Map<number, string>();
  for (const r of rows) {
    if (r.before == null || r.after == null) continue;
    const g = r.after - r.before;
    if (g > 0 && g > (gain.get(r.lemmaId)?.gain ?? 0)) {
      gain.set(r.lemmaId, { lemma: r.lemma, gain: g });
    }
    if (r.before < MATURE_DAYS && r.after >= MATURE_DAYS) matured.set(r.lemmaId, r.lemma);
  }

  return {
    newWords,
    stronger: {
      count: gain.size,
      examples: [...gain.values()]
        .sort((a, b) => b.gain - a.gain)
        .slice(0, EXAMPLES)
        .map((x) => x.lemma),
    },
    matured: { count: matured.size, examples: [...matured.values()] },
  };
}

/** The daily recap for `now`'s local day. Derived, nothing stored. */
export function getRecap(db: DB, now = new Date()): Recap {
  const done = kindsDone(db, localDay(now));
  return {
    ...summarize(db, now),
    streak: streak(db, now),
    practiceDone: done.has("practice"),
    episodeDone: done.has("episode"),
    complete: done.size === 2,
  };
}

/** One-line note at the end of a Practice session over the lemmas it showed. */
export function practiceLine(db: DB, lemmaIds: number[], now = new Date()): string {
  const s = summarize(db, now, lemmaIds);
  const parts = [
    `+${s.stronger.count} ${s.stronger.count === 1 ? "parola più solida" : "parole più solide"}`,
  ];
  if (s.matured.count > 0) {
    parts.push(`${s.matured.count} ${s.matured.count === 1 ? "consolidata" : "consolidate"}`);
  }
  return parts.join(" · ");
}

/**
 * One-line note after an Episode: its lemmas no earlier text contained.
 * ponytail: token lemmas only; MWE occurrences are not counted.
 */
export function episodeLine(db: DB, textId: number): string {
  const earlier = alias(token, "earlier");
  const [{ n }] = db
    .select({ n: countDistinct(token.lemmaId) })
    .from(token)
    .where(
      and(
        eq(token.textId, textId),
        isNotNull(token.lemmaId),
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

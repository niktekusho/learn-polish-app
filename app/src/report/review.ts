import { and, desc, eq, isNotNull, isNull, or } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "#/db/schema";
import { gloss, lemma, lemmaSlipRepair, reportReview } from "#/db/schema";
import { lookupDictionary } from "#/dictionary/service";
import type { GlossProvider, ReportReviewItem, ReportVerdict } from "#/llm/provider";
import { metSentences } from "#/passage/service";

type DB = BetterSQLite3Database<typeof schema>;
type Review = typeof reportReview.$inferSelect;

interface Pending {
  id: number;
  lemma: string;
  pos: string;
  kind: "wrong" | "context";
  note: string | null;
  contextBound: boolean;
}

function primaryGloss(db: DB, lemmaId: number) {
  return db
    .select({ italian: gloss.italian, provider: gloss.provider })
    .from(gloss)
    .where(and(eq(gloss.lemmaId, lemmaId), eq(gloss.sense, "")))
    .all()[0];
}

function latestReview(db: DB, lemmaId: number): Review | undefined {
  return db
    .select()
    .from(reportReview)
    .where(eq(reportReview.lemmaId, lemmaId))
    .orderBy(desc(reportReview.id))
    .limit(1)
    .all()[0];
}

/**
 * Lemmas with a wrong Report, and Context-bound marks no review has settled:
 * a mark set again after a review turned it off is pending again.
 */
export function pendingReports(db: DB): Pending[] {
  return db
    .select()
    .from(lemma)
    .where(or(isNotNull(lemma.flaggedAt), eq(lemma.contextBound, true)))
    .all()
    .filter((l) => {
      if (l.flaggedAt !== null) return true;
      const r = latestReview(db, l.id);
      // An undone review leaves its before mark in place.
      return !r || !(r.undoneAt ? r.markBefore : r.markAfter);
    })
    .map((l) => ({
      id: l.id,
      lemma: l.lemma,
      pos: l.pos,
      kind: l.flaggedAt !== null ? ("wrong" as const) : ("context" as const),
      note: l.flagNote,
      contextBound: l.contextBound,
    }));
}

function reviewItem(db: DB, p: Pending): ReportReviewItem {
  const current = primaryGloss(db, p.id);
  const previous = latestReview(db, p.id);
  return {
    lemma: p.lemma,
    pos: p.pos,
    kind: p.kind,
    note: p.note,
    gloss: current?.italian ?? null,
    manual: current?.provider === "manual",
    contextBound: p.contextBound,
    senses: lookupDictionary(db, p.lemma, p.pos, p.id)
      .entries.flatMap((e) => e.senses)
      .flatMap((s) => (s.italian ? [{ gloss: s.gloss, italian: s.italian }] : []))
      .map((s, index) => ({ index, ...s })),
    sentences: metSentences(db, p.id),
    previous: previous
      ? {
          glossBefore: previous.glossBefore,
          glossAfter: previous.glossAfter,
          markBefore: previous.markBefore,
          markAfter: previous.markAfter,
          reason: previous.reason,
          undone: previous.undoneAt !== null,
        }
      : null,
  };
}

/** The primary gloss a verdict leaves, or undefined when the verdict is invalid. */
function glossAfter(item: ReportReviewItem, v: ReportVerdict): string | null | undefined {
  if (item.manual || v.gloss === "keep") return item.gloss;
  if ("sense" in v.gloss) return item.senses[v.gloss.sense]?.italian;
  if (item.senses.length > 0 && !v.gloss.noSenseFits) return undefined;
  return v.gloss.italian;
}

/**
 * Review every pending Report in one provider call and apply each valid
 * verdict. An invalid item, or a failed call, stays pending for the next run.
 * Returns the number applied.
 */
export async function reviewReports(
  db: DB,
  provider: GlossProvider,
  now = new Date(),
): Promise<number> {
  if (!provider.reviewReports) return 0;
  const pending = pendingReports(db);
  if (pending.length === 0) return 0;
  const items = pending.map((p) => reviewItem(db, p));
  const verdicts = await provider.reviewReports(items);
  let applied = 0;
  verdicts.forEach((v, i) => {
    const p = pending[i];
    const after = v ? glossAfter(items[i], v) : undefined;
    if (!v || after === undefined) {
      console.error(`[report-review] invalid verdict for "${p.lemma}":`, v);
      return;
    }
    db.transaction((tx) => {
      const before = primaryGloss(tx, p.id);
      if (after !== null && after !== (before?.italian ?? null)) {
        tx.insert(gloss)
          .values({ lemmaId: p.id, sense: "", italian: after, provider: provider.name })
          .onConflictDoUpdate({
            target: [gloss.lemmaId, gloss.sense],
            set: { italian: after, provider: provider.name },
          })
          .run();
      }
      tx.update(lemma)
        .set({ contextBound: v.contextBound, flaggedAt: null, flagNote: null })
        .where(eq(lemma.id, p.id))
        .run();
      tx.insert(reportReview)
        .values({
          lemmaId: p.id,
          kind: p.kind,
          note: p.note,
          glossBefore: before?.italian ?? null,
          glossProviderBefore: before?.provider ?? null,
          glossAfter: after,
          markBefore: p.contextBound,
          markAfter: v.contextBound,
          reason: v.reason,
          reviewedAt: now,
        })
        .run();
    });
    applied++;
  });
  return applied;
}

export interface Correction {
  reviewId: number | null; // null: a Lemma slip repair, which has no undo
  line: string;
  reason: string | null;
  changed: boolean;
  undone: boolean;
  undoable: boolean;
}

const changed = (r: Review) => r.glossBefore !== r.glossAfter || r.markBefore !== r.markAfter;

function isCurrent(db: DB, r: Review): boolean {
  const [l] = db
    .select({ mark: lemma.contextBound })
    .from(lemma)
    .where(eq(lemma.id, r.lemmaId))
    .all();
  return l?.mark === r.markAfter && (primaryGloss(db, r.lemmaId)?.italian ?? null) === r.glossAfter;
}

function reviewCorrection(db: DB, r: Review, word: string): Correction {
  const parts: string[] = [];
  if (r.glossBefore !== r.glossAfter) parts.push(`"${r.glossBefore ?? "—"}" → "${r.glossAfter}"`);
  if (r.markBefore !== r.markAfter) {
    parts.push(
      r.markAfter ? "segnata come dipendente dal contesto" : "non più dipendente dal contesto",
    );
  }
  return {
    reviewId: r.id,
    line: `${word}: ${parts.join("; ") || "invariata"}`,
    reason: r.reason,
    changed: changed(r),
    undone: r.undoneAt !== null,
    undoable: r.undoneAt === null && isCurrent(db, r),
  };
}

function reviewsWithLemma(db: DB, onlyUnseen: boolean) {
  return db
    .select({ review: reportReview, word: lemma.lemma })
    .from(reportReview)
    .innerJoin(lemma, eq(lemma.id, reportReview.lemmaId))
    .where(onlyUnseen ? isNull(reportReview.seenAt) : undefined)
    .orderBy(desc(reportReview.id))
    .all();
}

/** Every Report review, newest first. */
export function listReviews(db: DB): Correction[] {
  return reviewsWithLemma(db, false).map((r) => reviewCorrection(db, r.review, r.word));
}

/** Unseen Report reviews and Lemma slip repairs for the next Practice, marked seen. */
export function takeCorrections(db: DB, now = new Date()): Correction[] {
  return db.transaction((tx) => {
    const reviews = reviewsWithLemma(tx, true).map((r) => reviewCorrection(tx, r.review, r.word));
    const slips = tx
      .select()
      .from(lemmaSlipRepair)
      .where(isNull(lemmaSlipRepair.seenAt))
      .all()
      .map((s) => ({
        reviewId: null,
        line: `${s.slip} → ${s.target}`,
        reason: null,
        changed: true,
        undone: false,
        undoable: false,
      }));
    tx.update(reportReview).set({ seenAt: now }).where(isNull(reportReview.seenAt)).run();
    tx.update(lemmaSlipRepair).set({ seenAt: now }).where(isNull(lemmaSlipRepair.seenAt)).run();
    return [...reviews, ...slips];
  });
}

/**
 * Restore what a review replaced, while what it wrote is still current. Undoing
 * a review that changed nothing files a new wrong Report with `note` instead.
 */
export function undoReview(db: DB, reviewId: number, note = "", now = new Date()): void {
  db.transaction((tx) => {
    const [r] = tx.select().from(reportReview).where(eq(reportReview.id, reviewId)).all();
    if (!r || r.undoneAt !== null || !isCurrent(tx, r)) {
      throw new Error("This review can no longer be undone.");
    }
    if (!changed(r)) {
      tx.update(lemma)
        .set({ flaggedAt: now, flagNote: note.trim() || null })
        .where(eq(lemma.id, r.lemmaId))
        .run();
    }
    if (r.glossBefore === null) {
      tx.delete(gloss)
        .where(and(eq(gloss.lemmaId, r.lemmaId), eq(gloss.sense, "")))
        .run();
    } else if (r.glossBefore !== r.glossAfter) {
      const restored = { italian: r.glossBefore, provider: r.glossProviderBefore! };
      tx.insert(gloss)
        .values({ lemmaId: r.lemmaId, sense: "", ...restored })
        .onConflictDoUpdate({ target: [gloss.lemmaId, gloss.sense], set: restored })
        .run();
    }
    tx.update(lemma).set({ contextBound: r.markBefore }).where(eq(lemma.id, r.lemmaId)).run();
    tx.update(reportReview).set({ undoneAt: now }).where(eq(reportReview.id, r.id)).run();
  });
}

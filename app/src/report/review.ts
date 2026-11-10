import { and, asc, desc, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "#/db/schema";
import { dictEntry, dictForm, gloss, lemma, lemmaSlipRepair, token } from "#/db/schema";
import { sentenceText } from "#/dictionary/mwe-check";
import { lookupDictionary } from "#/dictionary/service";
import { nameBase } from "#/import/classify";
import { ensureReceptiveKnowledge, upsertLemma } from "#/import/pipeline";
import type { Llm } from "#/llm/call";
import { metSentences } from "#/passage/service";
import { plural } from "#/plural";
import { NAME_POS } from "#/reader/name";
import {
  CAPITAL,
  characterForms,
  moveToNames,
  storyCharacters,
  storyOf,
} from "#/story/character-names";
import { reportReview, type ReportReviewItem, type ReportVerdict } from "./llm";

type DB = BetterSQLite3Database<typeof schema>;
type Review = typeof schema.reportReview.$inferSelect;

interface Pending {
  id: number;
  lemma: string;
  pos: string;
  note: string | null;
  contextBound: boolean;
  flagTokenId: number | null;
}

interface NameCandidate {
  tokenId: number;
  textId: number;
  surface: string;
  sentence: string;
}

/**
 * The learner reports something wrong with a lemma (CONTEXT.md "Report"): it
 * leaves Practice until its Report review. `tokenId` is the reader token it was
 * reported on.
 */
export function reportLemma(db: DB, lemmaId: number, note: string, tokenId?: number): void {
  db.update(lemma)
    .set({ flaggedAt: new Date(), flagNote: note.trim() || null, flagTokenId: tokenId ?? null })
    .where(eq(lemma.id, lemmaId))
    .run();
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
    .from(schema.reportReview)
    .where(eq(schema.reportReview.lemmaId, lemmaId))
    .orderBy(desc(schema.reportReview.id))
    .limit(1)
    .all()[0];
}

/** Lemmas with a Report no review has answered yet. */
export function pendingReports(db: DB): Pending[] {
  return db
    .select()
    .from(lemma)
    .where(isNotNull(lemma.flaggedAt))
    .all()
    .map((l) => ({
      id: l.id,
      lemma: l.lemma,
      pos: l.pos,
      note: l.flagNote,
      contextBound: l.contextBound,
      flagTokenId: l.flagTokenId,
    }));
}

/**
 * Occurrences a Report review may judge a Name: the lemma's capitalized
 * tokens, and the same surface in the reported text under any other lemma.
 */
function nameCandidates(db: DB, p: Pending): NameCandidate[] {
  const [reported] =
    p.flagTokenId === null ? [] : db.select().from(token).where(eq(token.id, p.flagTokenId)).all();
  return db
    .select()
    .from(token)
    .where(
      reported
        ? or(
            eq(token.lemmaId, p.id),
            and(
              eq(token.textId, reported.textId),
              eq(token.surface, reported.surface),
              isNotNull(token.lemmaId),
            ),
          )
        : eq(token.lemmaId, p.id),
    )
    .orderBy(asc(token.textId), asc(token.position))
    .all()
    .filter((t) => CAPITAL.test(t.surface.trim()))
    .map((t) => ({
      tokenId: t.id,
      textId: t.textId,
      surface: t.surface,
      sentence: sentenceText(db, t.textId, t.sentenceIndex),
    }));
}

/**
 * The base form of a confirmed Name: the Story character it names, else the
 * capitalized common headword whose forms hold it (Iskro → Iskra).
 */
function nameFor(db: DB, c: NameCandidate): string {
  const word = c.surface.trim();
  const lower = word.toLowerCase();
  const storyId = storyOf(db, c.textId);
  if (storyId) {
    const character = characterForms(db, storyCharacters(db, storyId)).get(lower);
    if (character) return character.character.name;
  }
  const headwords = new Set(
    db
      .select({ word: dictEntry.word })
      .from(dictForm)
      .innerJoin(dictEntry, eq(dictForm.entryId, dictEntry.id))
      .where(and(eq(dictForm.form, lower), ne(dictEntry.pos, "name")))
      .all()
      .map((r) => r.word),
  );
  if (headwords.size !== 1) return nameBase(db, word);
  const [headword] = headwords;
  return headword.charAt(0).toUpperCase() + headword.slice(1);
}

function reviewItem(db: DB, p: Pending, candidates: NameCandidate[]): ReportReviewItem {
  const current = primaryGloss(db, p.id);
  const previous = latestReview(db, p.id);
  return {
    lemma: p.lemma,
    pos: p.pos,
    note: p.note,
    gloss: current?.italian ?? null,
    manual: current?.provider === "manual",
    contextBound: p.contextBound,
    senses: lookupDictionary(db, p.lemma, p.pos, p.id)
      .entries.flatMap((e) => e.senses)
      .flatMap((s) => (s.italian ? [{ gloss: s.gloss, italian: s.italian }] : []))
      .map((s, index) => ({ index, ...s })),
    sentences: metSentences(db, p.id),
    names: candidates.map((c, index) => ({ index, surface: c.surface, sentence: c.sentence })),
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
 * Review every pending Report in one LLM call and apply each valid
 * verdict. An invalid item, or a failed call, stays pending for the next run.
 * Returns the number applied.
 */
export async function reviewReports(db: DB, llm: Llm, now = new Date()): Promise<number> {
  const pending = pendingReports(db);
  if (pending.length === 0) return 0;
  const candidates = pending.map((p) => nameCandidates(db, p));
  const items = pending.map((p, i) => reviewItem(db, p, candidates[i]));
  const verdicts = await llm.call(reportReview, items);
  let applied = 0;
  verdicts.forEach((v, i) => {
    const p = pending[i];
    const after = v ? glossAfter(items[i], v) : undefined;
    const names = v?.names.map((n) => candidates[i][n]) ?? [];
    if (!v || after === undefined || names.some((c) => c === undefined)) {
      console.error(`[report-review] invalid verdict for "${p.lemma}":`, v);
      return;
    }
    // An earlier verdict in this batch moved all its tokens to a Name and deleted it.
    if (db.select().from(lemma).where(eq(lemma.id, p.id)).all().length === 0) return;
    db.transaction((tx) => {
      const before = primaryGloss(tx, p.id);
      if (after !== null && after !== (before?.italian ?? null)) {
        tx.insert(gloss)
          .values({ lemmaId: p.id, sense: "", italian: after, provider: llm.name })
          .onConflictDoUpdate({
            target: [gloss.lemmaId, gloss.sense],
            set: { italian: after, provider: llm.name },
          })
          .run();
      }
      tx.update(lemma)
        .set({ contextBound: v.contextBound, flaggedAt: null, flagNote: null, flagTokenId: null })
        .where(eq(lemma.id, p.id))
        .run();
      const [{ id }] = tx
        .insert(schema.reportReview)
        .values({
          lemmaId: p.id,
          word: p.lemma,
          note: p.note,
          glossBefore: before?.italian ?? null,
          glossProviderBefore: before?.provider ?? null,
          glossAfter: after,
          markBefore: p.contextBound,
          markAfter: v.contextBound,
          reason: v.reason,
          reviewedAt: now,
        })
        .returning({ id: schema.reportReview.id })
        .all();
      // After the review row: a lemma left without tokens is deleted and the row keeps its word.
      const nameOf = new Map(names.map((c) => [c.tokenId, nameFor(tx, c)]));
      const moves = [...nameOf].map(([tokenId, name]) => ({ tokenId, name }));
      const { from } = moveToNames(tx, moves);
      if (from.length > 0) {
        const moved = from.map((f) => ({ ...f, name: nameOf.get(f.tokenId) as string }));
        tx.update(schema.reportReview)
          .set({ names: moved })
          .where(eq(schema.reportReview.id, id))
          .run();
      }
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

const changed = (r: Review) =>
  r.glossBefore !== r.glossAfter || r.markBefore !== r.markAfter || r.names.length > 0;

/** What the review wrote is untouched: gloss and mark, unless it deleted the lemma, and its Name moves. */
function isCurrent(db: DB, r: Review): boolean {
  if (r.lemmaId !== null) {
    const [l] = db
      .select({ mark: lemma.contextBound })
      .from(lemma)
      .where(eq(lemma.id, r.lemmaId))
      .all();
    const gloss = primaryGloss(db, r.lemmaId)?.italian ?? null;
    if (l?.mark !== r.markAfter || gloss !== r.glossAfter) return false;
  }
  return r.names.every((m) => {
    const [t] = db
      .select({ lemma: lemma.lemma, pos: lemma.pos })
      .from(token)
      .innerJoin(lemma, eq(token.lemmaId, lemma.id))
      .where(eq(token.id, m.tokenId))
      .all();
    return t?.lemma === m.name && t.pos === NAME_POS;
  });
}

function reviewCorrection(db: DB, r: Review): Correction {
  const parts: string[] = [];
  if (r.glossBefore !== r.glossAfter)
    parts.push(`${r.glossBefore === null ? "nessuna" : `"${r.glossBefore}"`} → "${r.glossAfter}"`);
  if (r.markBefore !== r.markAfter) {
    parts.push(
      r.markAfter ? "segnata come dipendente dal contesto" : "non più dipendente dal contesto",
    );
  }
  if (r.names.length > 0) {
    const n = r.names.length;
    const names = [...new Set(r.names.map((m) => m.name))].join(", ");
    parts.push(`${n} ${plural(n, "occorrenza", "occorrenze")} ora ${names}`);
  }
  return {
    reviewId: r.id,
    line: `${r.word}: ${parts.join("; ") || "invariata"}`,
    reason: r.reason,
    changed: changed(r),
    undone: r.undoneAt !== null,
    undoable: r.undoneAt === null && isCurrent(db, r),
  };
}

function reviews(db: DB, onlyUnseen: boolean) {
  return db
    .select()
    .from(schema.reportReview)
    .where(onlyUnseen ? isNull(schema.reportReview.seenAt) : undefined)
    .orderBy(desc(schema.reportReview.id))
    .all();
}

/** Every Report review, newest first. */
export function listReviews(db: DB): Correction[] {
  return reviews(db, false).map((r) => reviewCorrection(db, r));
}

/** Unseen Report reviews and Lemma slip repairs for the next Practice, marked seen. */
export function takeCorrections(db: DB, now = new Date()): Correction[] {
  return db.transaction((tx) => {
    const unseen = reviews(tx, true).map((r) => reviewCorrection(tx, r));
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
    tx.update(schema.reportReview)
      .set({ seenAt: now })
      .where(isNull(schema.reportReview.seenAt))
      .run();
    tx.update(lemmaSlipRepair).set({ seenAt: now }).where(isNull(lemmaSlipRepair.seenAt)).run();
    return [...unseen, ...slips];
  });
}

/**
 * Restore what a review replaced, while what it wrote is still current: Name
 * uses go back to their word, which starts as new if the review deleted it.
 * Undoing a review that changed nothing files a new Report with `note` instead.
 */
export function undoReview(db: DB, reviewId: number, note = "", now = new Date()): void {
  db.transaction((tx) => {
    const [r] = tx
      .select()
      .from(schema.reportReview)
      .where(eq(schema.reportReview.id, reviewId))
      .all();
    if (!r || r.undoneAt !== null || !isCurrent(tx, r)) {
      throw new Error("This review can no longer be undone.");
    }
    const lemmaId = r.lemmaId;
    if (lemmaId !== null) {
      if (!changed(r)) {
        tx.update(lemma)
          .set({ flaggedAt: now, flagNote: note.trim() || null })
          .where(eq(lemma.id, lemmaId))
          .run();
      }
      if (r.glossBefore === null) {
        tx.delete(gloss)
          .where(and(eq(gloss.lemmaId, lemmaId), eq(gloss.sense, "")))
          .run();
      } else if (r.glossBefore !== r.glossAfter) {
        const restored = { italian: r.glossBefore, provider: r.glossProviderBefore! };
        tx.insert(gloss)
          .values({ lemmaId, sense: "", ...restored })
          .onConflictDoUpdate({ target: [gloss.lemmaId, gloss.sense], set: restored })
          .run();
      }
      tx.update(lemma).set({ contextBound: r.markBefore }).where(eq(lemma.id, lemmaId)).run();
    }
    for (const m of r.names) {
      const id = upsertLemma(tx, m.lemma, m.pos);
      if (m.pos !== NAME_POS) ensureReceptiveKnowledge(tx, id, now);
      tx.update(token).set({ lemmaId: id }).where(eq(token.id, m.tokenId)).run();
    }
    tx.update(schema.reportReview)
      .set({ undoneAt: now })
      .where(eq(schema.reportReview.id, r.id))
      .run();
  });
}

import { and, asc, count, eq, isNotNull, isNull, notExists } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "#/db/schema";
import {
  dictEntry,
  dictForm,
  dictSense,
  gloss,
  knowledge,
  lemma,
  mweOccurrence,
  passageQuestion,
  reviewLog,
  sourceText,
  token,
} from "#/db/schema";
import { wipeDictionary } from "#/dictionary/loader";
import { setManualGloss } from "#/gloss/service";
import { classifyToken } from "#/import/classify";
import { upsertLemma } from "#/import/pipeline";
import type { AnalyzeResponse } from "#/import/sidecar";
import { NAME_POS } from "#/reader/name";

type DB = BetterSQLite3Database<typeof schema>;

export interface MaintenanceStats {
  texts: number;
  tokens: number;
  lemmas: number;
  glosses: number;
  stubGlosses: number;
  knowledge: number;
  reviews: number;
  dictEntries: number;
  dictSenses: number;
  dictForms: number;
  dictMwes: number;
}

export function getStats(db: DB): MaintenanceStats {
  const one = (t: SQLiteTable) => db.select({ n: count() }).from(t).all()[0].n;
  return {
    texts: one(sourceText),
    tokens: one(token),
    lemmas: one(lemma),
    glosses: one(gloss),
    stubGlosses: db.select({ n: count() }).from(gloss).where(eq(gloss.provider, "stub")).all()[0].n,
    knowledge: one(knowledge),
    reviews: one(reviewLog),
    dictEntries: one(dictEntry),
    dictSenses: one(dictSense),
    dictForms: one(dictForm),
    dictMwes: db.select({ n: count() }).from(dictEntry).where(eq(dictEntry.isMwe, true)).all()[0].n,
  };
}

/**
 * Delete every imported text. Tokens cascade; lemmas, glosses, knowledge and
 * review history are untouched — translations and FSRS progress survive.
 */
export function clearSourceTexts(db: DB): number {
  return db.delete(sourceText).run().changes;
}

/**
 * Delete lemmas that carry nothing: no token references them, no gloss was
 * ever produced, they were never reviewed, and no MWE occurrence points at
 * them (MWE lemmas have no token rows — their components keep their own
 * lemmas — so without this check every unglossed MWE would be pruned).
 * Suppressed MWEs stay: the row holds the never-detect mark.
 * Their (empty) knowledge rows cascade. Run after clearSourceTexts to sweep
 * the never-practiced backlog.
 */
export function pruneOrphanLemmas(db: DB): number {
  return db
    .delete(lemma)
    .where(
      and(
        eq(lemma.suppressed, false),
        notExists(db.select().from(token).where(eq(token.lemmaId, lemma.id))),
        notExists(db.select().from(gloss).where(eq(gloss.lemmaId, lemma.id))),
        notExists(db.select().from(reviewLog).where(eq(reviewLog.lemmaId, lemma.id))),
        notExists(db.select().from(mweOccurrence).where(eq(mweOccurrence.lemmaId, lemma.id))),
      ),
    )
    .run().changes;
}

/** Delete glosses written by the dev stub provider so real ones regenerate. */
export function purgeStubGlosses(db: DB): number {
  return db.delete(gloss).where(eq(gloss.provider, "stub")).run().changes;
}

/** Delete the whole home dictionary (entries, senses, forms). */
export function clearDictionary(db: DB): number {
  return wipeDictionary(db);
}

export interface FlaggedLemma {
  lemmaId: number;
  lemma: string;
  pos: string;
  gloss: string | null;
  note: string | null;
  flaggedAt: Date;
}

/** Lemmas reported from Practice ("requires attention"), oldest first. */
export function listFlagged(db: DB): FlaggedLemma[] {
  return db
    .select({
      lemmaId: lemma.id,
      lemma: lemma.lemma,
      pos: lemma.pos,
      gloss: gloss.italian,
      note: lemma.flagNote,
      flaggedAt: lemma.flaggedAt,
    })
    .from(lemma)
    .leftJoin(gloss, and(eq(gloss.lemmaId, lemma.id), eq(gloss.sense, "")))
    .where(isNotNull(lemma.flaggedAt))
    .orderBy(asc(lemma.flaggedAt))
    .all() as FlaggedLemma[];
}

/**
 * Clear a flag, optionally writing a corrected gloss first (manual tier).
 * The lemma rejoins practice with its FSRS state untouched.
 */
export function resolveFlag(db: DB, lemmaId: number, italian?: string): void {
  if (italian !== undefined) setManualGloss(db, lemmaId, italian);
  db.update(lemma).set({ flaggedAt: null, flagNote: null }).where(eq(lemma.id, lemmaId)).run();
}

export interface ContextBoundLemma {
  lemmaId: number;
  lemma: string;
  pos: string;
}

/** Lemmas marked "needs context" from Practice, alphabetical. */
export function listContextBound(db: DB): ContextBoundLemma[] {
  return db
    .select({ lemmaId: lemma.id, lemma: lemma.lemma, pos: lemma.pos })
    .from(lemma)
    .where(eq(lemma.contextBound, true))
    .orderBy(asc(lemma.lemma))
    .all();
}

/** Undo a "needs context" mark: the lemma rejoins the single-word exercises. */
export function unmarkContextBound(db: DB, lemmaId: number): void {
  db.update(lemma).set({ contextBound: false }).where(eq(lemma.id, lemmaId)).run();
}

/** MWEs marked never-detect from the reader, alphabetical. */
export function listSuppressedMwes(db: DB): ContextBoundLemma[] {
  return db
    .select({ lemmaId: lemma.id, lemma: lemma.lemma, pos: lemma.pos })
    .from(lemma)
    .where(and(eq(lemma.suppressed, true), eq(lemma.pos, "MWE")))
    .orderBy(asc(lemma.lemma))
    .all();
}

// ponytail: fragments spotted by hand in prod data; add new ones here.
const NAME_FRAGMENTS = new Set(["Dzię"]);

export interface NameRepair {
  deleted: number; // no-letter and fragment lemmas
  commonWords: number; // mis-tagged common words relinked or converted
  merged: number; // name variants merged into their base
  cleared: number; // knowledge, gloss and review rows dropped from Names
}

/**
 * A PROPN lemma can carry vocabulary data classifyToken would not create: Names lose
 * knowledge, glosses and reviews and merge into their base, common words join their
 * lemma, no-letter lemmas and fragments go. Idempotent.
 */
export function repairNames(db: DB): NameRepair {
  const out: NameRepair = { deleted: 0, commonWords: 0, merged: 0, cleared: 0 };
  db.transaction((tx) => {
    const relink = (from: number, to: number | null) =>
      tx.update(token).set({ lemmaId: to }).where(eq(token.lemmaId, from)).run();
    const clear = (id: number) => {
      let n = 0;
      for (const t of [knowledge, reviewLog, gloss, passageQuestion]) {
        n += tx.delete(t).where(eq(t.lemmaId, id)).run().changes;
      }
      return n;
    };
    const drop = (id: number) => {
      clear(id);
      tx.delete(lemma).where(eq(lemma.id, id)).run();
    };

    for (const l of tx.select().from(lemma).where(eq(lemma.pos, NAME_POS)).all()) {
      const classified = NAME_FRAGMENTS.has(l.lemma)
        ? ({ kind: "skip" } as const)
        : classifyToken(tx, { lemma: l.lemma, pos: NAME_POS, is_space: false });
      switch (classified.kind) {
        case "skip":
          relink(l.id, null);
          drop(l.id);
          out.deleted++;
          break;
        case "unit": {
          const [existing] = tx
            .select({ id: lemma.id })
            .from(lemma)
            .where(and(eq(lemma.lemma, classified.lemma), eq(lemma.pos, classified.pos)))
            .all();
          if (existing) {
            relink(l.id, existing.id);
            drop(l.id);
          } else {
            tx.update(lemma)
              .set({ lemma: classified.lemma, pos: classified.pos })
              .where(eq(lemma.id, l.id))
              .run();
          }
          out.commonWords++;
          break;
        }
        case "name": {
          let target = l.id;
          if (classified.lemma !== l.lemma) {
            target = upsertLemma(tx, classified.lemma, NAME_POS);
            relink(l.id, target);
            drop(l.id);
            out.merged++;
          }
          out.cleared += clear(target);
        }
      }
    }
  });
  return out;
}

export interface TagBackfill {
  filled: number; // texts whose tokens got morph tags
  skipped: number; // texts whose re-analysis did not match the stored tokens
  failed: number; // texts the sidecar could not analyze (unreachable or erroring)
}

/**
 * Tokens with null tags get them by re-analyzing their text and copying by position.
 * A text whose re-analysis yields different tokens is skipped.
 */
export async function backfillTokenTags(
  db: DB,
  analyze: (text: string) => Promise<AnalyzeResponse>,
): Promise<TagBackfill> {
  const out: TagBackfill = { filled: 0, skipped: 0, failed: 0 };
  const texts = db
    .selectDistinct({ id: sourceText.id, content: sourceText.content })
    .from(sourceText)
    .innerJoin(token, eq(token.textId, sourceText.id))
    .where(isNull(token.tags))
    .all();
  for (const text of texts) {
    let analysis: AnalyzeResponse;
    try {
      analysis = await analyze(text.content);
    } catch {
      out.failed++;
      continue;
    }
    const fresh = analysis.sentences.flatMap((s) => s.tokens);
    const stored = db
      .select({ id: token.id, surface: token.surface, tags: token.tags })
      .from(token)
      .where(eq(token.textId, text.id))
      .orderBy(asc(token.position))
      .all();
    if (fresh.length !== stored.length || fresh.some((t, i) => t.surface !== stored[i].surface)) {
      out.skipped++;
      continue;
    }
    db.transaction((tx) => {
      stored.forEach((t, i) => {
        if (t.tags === null) {
          tx.update(token).set({ tags: fresh[i].tags }).where(eq(token.id, t.id)).run();
        }
      });
    });
    out.filled++;
  }
  return out;
}

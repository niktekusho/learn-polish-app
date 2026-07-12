import { and, count, eq, notExists } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import * as schema from '#/db/schema'
import {
  dictEntry,
  dictForm,
  dictSense,
  gloss,
  knowledge,
  lemma,
  reviewLog,
  sourceText,
  token,
} from '#/db/schema'
import { wipeDictionary } from '#/dictionary/loader'

type DB = BetterSQLite3Database<typeof schema>

export interface MaintenanceStats {
  texts: number
  tokens: number
  lemmas: number
  glosses: number
  stubGlosses: number
  knowledge: number
  reviews: number
  dictEntries: number
  dictSenses: number
  dictForms: number
  dictMwes: number
}

export function getStats(db: DB): MaintenanceStats {
  const one = (t: SQLiteTable) => db.select({ n: count() }).from(t).all()[0].n
  return {
    texts: one(sourceText),
    tokens: one(token),
    lemmas: one(lemma),
    glosses: one(gloss),
    stubGlosses: db
      .select({ n: count() })
      .from(gloss)
      .where(eq(gloss.provider, 'stub'))
      .all()[0].n,
    knowledge: one(knowledge),
    reviews: one(reviewLog),
    dictEntries: one(dictEntry),
    dictSenses: one(dictSense),
    dictForms: one(dictForm),
    dictMwes: db
      .select({ n: count() })
      .from(dictEntry)
      .where(eq(dictEntry.isMwe, true))
      .all()[0].n,
  }
}

/**
 * Delete every imported text. Tokens cascade; lemmas, glosses, knowledge and
 * review history are untouched — translations and FSRS progress survive.
 */
export function clearSourceTexts(db: DB): number {
  return db.delete(sourceText).run().changes
}

/**
 * Delete lemmas that carry nothing: no token references them, no gloss was
 * ever produced, and they were never reviewed. Their (empty) knowledge rows
 * cascade. Run after clearSourceTexts to sweep the never-practiced backlog.
 */
export function pruneOrphanLemmas(db: DB): number {
  return db
    .delete(lemma)
    .where(
      and(
        notExists(db.select().from(token).where(eq(token.lemmaId, lemma.id))),
        notExists(db.select().from(gloss).where(eq(gloss.lemmaId, lemma.id))),
        notExists(
          db.select().from(reviewLog).where(eq(reviewLog.lemmaId, lemma.id)),
        ),
      ),
    )
    .run().changes
}

/** Delete glosses written by the dev stub provider so real ones regenerate. */
export function purgeStubGlosses(db: DB): number {
  return db.delete(gloss).where(eq(gloss.provider, 'stub')).run().changes
}

/** Delete the whole home dictionary (entries, senses, forms). */
export function clearDictionary(db: DB): number {
  return wipeDictionary(db)
}

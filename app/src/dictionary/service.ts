import { asc, eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '#/db/schema'
import { dictEntry, dictForm, dictSense } from '#/db/schema'

type DB = BetterSQLite3Database<typeof schema>

// spaCy UPOS -> kaikki pos codes, in lookup-preference order.
export const UPOS_TO_KAIKKI: Record<string, string[]> = {
  NOUN: ['noun'],
  PROPN: ['name', 'noun'],
  VERB: ['verb'],
  AUX: ['verb'],
  ADJ: ['adj'],
  ADV: ['adv'],
  PRON: ['pron'],
  ADP: ['prep', 'postp'],
  CCONJ: ['conj'],
  SCONJ: ['conj'],
  NUM: ['num'],
  PART: ['particle'],
  INTJ: ['intj'],
  DET: ['det', 'pron'],
}

export interface DictSenseView {
  gloss: string
  rawGloss: string | null
  tags: string[]
}

export interface DictEntryView {
  id: number
  word: string
  pos: string
  ipa: string | null
  etymology: string | null
  senses: DictSenseView[]
  forms: { form: string; tags: string[] }[]
}

export interface DictLookupResult {
  matchedBy: 'lemma+pos' | 'lemma' | null // null = not in dictionary
  entries: DictEntryView[]
}

/**
 * Look up a lemma in the home dictionary.
 *
 * Match rule: exact word + UPOS-mapped kaikki pos first; then word alone
 * (spaCy and Wiktionary disagree on POS occasionally — participles tagged
 * ADJ, entries only under verb); then a lowercased retry (sentence-initial
 * casing / PROPN mis-lemmatization). An unknown or unmappable UPOS ('', MWE)
 * goes straight to the word-only fallback — drizzle's inArray throws on [].
 */
export function lookupDictionary(
  db: DB,
  lemma: string,
  upos: string,
): DictLookupResult {
  const mapped = UPOS_TO_KAIKKI[upos] ?? []

  for (const word of [lemma, lemma.toLowerCase()]) {
    if (mapped.length > 0) {
      const rows = db
        .select()
        .from(dictEntry)
        .where(eq(dictEntry.word, word))
        .all()
        .filter((r) => mapped.includes(r.pos))
      if (rows.length > 0) return { matchedBy: 'lemma+pos', entries: hydrate(db, rows) }
    }
    const rows = db.select().from(dictEntry).where(eq(dictEntry.word, word)).all()
    if (rows.length > 0) return { matchedBy: 'lemma', entries: hydrate(db, rows) }
    if (word === lemma.toLowerCase()) break // no second iteration needed
  }
  return { matchedBy: null, entries: [] }
}

function hydrate(
  db: DB,
  rows: (typeof dictEntry.$inferSelect)[],
): DictEntryView[] {
  const ids = rows.map((r) => r.id)
  const senses = db
    .select()
    .from(dictSense)
    .where(inArray(dictSense.entryId, ids))
    .orderBy(asc(dictSense.senseIndex))
    .all()
  const forms = db
    .select()
    .from(dictForm)
    .where(inArray(dictForm.entryId, ids))
    .all()
  return rows.map((r) => ({
    id: r.id,
    word: r.word,
    pos: r.pos,
    ipa: r.ipa,
    etymology: r.etymology,
    senses: senses
      .filter((s) => s.entryId === r.id)
      .map((s) => ({ gloss: s.gloss, rawGloss: s.rawGloss, tags: s.tags })),
    forms: forms
      .filter((f) => f.entryId === r.id)
      .map((f) => ({ form: f.form, tags: f.tags })),
  }))
}

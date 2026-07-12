import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, test } from 'vitest'
import * as schema from '#/db/schema'
import { insertEntryBatch } from './loader'
import type { ParsedEntry } from './parse'
import { lookupDictionary } from './service'

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'drizzle' })
  return db
}

function entry(overrides: Partial<ParsedEntry>): ParsedEntry {
  return {
    word: 'zamek',
    pos: 'noun',
    ipa: null,
    etymology: null,
    isMwe: false,
    senses: [{ gloss: 'castle', rawGloss: null, tags: [] }],
    forms: [],
    ...overrides,
  }
}

function seed(db: ReturnType<typeof freshDb>, entries: ParsedEntry[]) {
  insertEntryBatch(db, entries)
}

test('lemma+pos match wins and hydrates senses in order', () => {
  const db = freshDb()
  seed(db, [
    entry({
      senses: [
        { gloss: 'castle', rawGloss: null, tags: [] },
        { gloss: 'lock', rawGloss: null, tags: [] },
      ],
      forms: [{ form: 'zamku', tags: ['genitive'] }],
    }),
    entry({ word: 'zamek', pos: 'verb', senses: [{ gloss: 'bogus', rawGloss: null, tags: [] }] }),
  ])
  const res = lookupDictionary(db, 'zamek', 'NOUN')
  expect(res.matchedBy).toBe('lemma+pos')
  expect(res.entries).toHaveLength(1)
  expect(res.entries[0].senses.map((s) => s.gloss)).toEqual(['castle', 'lock'])
  expect(res.entries[0].forms).toEqual([{ form: 'zamku', tags: ['genitive'] }])
})

test('falls back to lemma-only match when UPOS maps to a different kaikki pos', () => {
  const db = freshDb()
  seed(db, [entry({ word: 'otwarty', pos: 'verb' })])
  // spaCy says ADJ (participle); dictionary only has a verb entry.
  const res = lookupDictionary(db, 'otwarty', 'ADJ')
  expect(res.matchedBy).toBe('lemma')
  expect(res.entries).toHaveLength(1)
})

test('empty/unmapped UPOS goes straight to lemma-only fallback (no inArray([]) throw)', () => {
  const db = freshDb()
  seed(db, [entry({ word: 'na pewno', pos: 'adv', isMwe: true })])
  const res = lookupDictionary(db, 'na pewno', 'MWE')
  expect(res.matchedBy).toBe('lemma')
  expect(res.entries[0].word).toBe('na pewno')
})

test('PROPN maps to name entries', () => {
  const db = freshDb()
  seed(db, [entry({ word: 'Polska', pos: 'name', senses: [{ gloss: 'Poland', rawGloss: null, tags: [] }] })])
  const res = lookupDictionary(db, 'Polska', 'PROPN')
  expect(res.matchedBy).toBe('lemma+pos')
})

test('lowercase retry catches sentence-initial casing', () => {
  const db = freshDb()
  seed(db, [entry({ word: 'kot' })])
  const res = lookupDictionary(db, 'Kot', 'NOUN')
  expect(res.matchedBy).toBe('lemma+pos')
  expect(res.entries[0].word).toBe('kot')
})

test('miss returns null matchedBy and empty entries', () => {
  const db = freshDb()
  const res = lookupDictionary(db, 'xyzzy', 'NOUN')
  expect(res).toEqual({ matchedBy: null, entries: [] })
})

test('multiple entries for the same word+pos are all returned', () => {
  const db = freshDb()
  seed(db, [
    entry({ etymology: 'Etymology 1' }),
    entry({ etymology: 'Etymology 2' }),
  ])
  const res = lookupDictionary(db, 'zamek', 'NOUN')
  expect(res.entries).toHaveLength(2)
})

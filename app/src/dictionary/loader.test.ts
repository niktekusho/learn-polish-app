import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, test } from 'vitest'
import * as schema from '#/db/schema'
import { insertEntryBatch, wipeDictionary } from './loader'
import type { ParsedEntry } from './parse'

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'drizzle' })
  return db
}

const entries: ParsedEntry[] = [
  {
    word: 'zamek',
    pos: 'noun',
    ipa: '/ˈza.mɛk/',
    etymology: 'From Proto-Slavic.',
    isMwe: false,
    senses: [
      { gloss: 'castle', rawGloss: null, tags: [] },
      { gloss: 'lock', rawGloss: null, tags: ['device'] },
    ],
    forms: [{ form: 'zamku', tags: ['genitive', 'singular'] }],
  },
  {
    word: 'na pewno',
    pos: 'adv',
    ipa: null,
    etymology: null,
    isMwe: true,
    senses: [{ gloss: 'certainly', rawGloss: null, tags: [] }],
    forms: [],
  },
]

test('insertEntryBatch persists entries, senses, forms; wipe removes all', () => {
  const db = freshDb()
  insertEntryBatch(db, entries)

  expect(db.select().from(schema.dictEntry).all()).toHaveLength(2)
  const senses = db.select().from(schema.dictSense).all()
  expect(senses).toHaveLength(3)
  expect(senses.find((s) => s.gloss === 'lock')?.tags).toEqual(['device'])
  expect(db.select().from(schema.dictForm).all()).toHaveLength(1)

  const wiped = wipeDictionary(db)
  expect(wiped).toBe(2)
  expect(db.select().from(schema.dictSense).all()).toHaveLength(0) // cascade
  expect(db.select().from(schema.dictForm).all()).toHaveLength(0)

  // Re-import works from empty.
  insertEntryBatch(db, entries)
  expect(db.select().from(schema.dictEntry).all()).toHaveLength(2)
})

test('empty batch is a no-op', () => {
  const db = freshDb()
  insertEntryBatch(db, [])
  expect(db.select().from(schema.dictEntry).all()).toHaveLength(0)
})

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, test } from 'vitest'
import * as schema from '#/db/schema'
import type { GlossProvider } from '#/llm/provider'
import { getGloss, regenerateGloss, setManualGloss } from './service'

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'drizzle' })
  return db
}

function countingProvider(): GlossProvider & { calls: number } {
  return {
    name: 'stub',
    calls: 0,
    async gloss(req) {
      this.calls++
      return `IT:${req.lemma}`
    },
  }
}

function addLemma(db: ReturnType<typeof freshDb>, word: string) {
  const [{ id }] = db
    .insert(schema.lemma)
    .values({ lemma: word, pos: 'NOUN' })
    .returning({ id: schema.lemma.id })
    .all()
  return id
}

test('first lookup generates + caches (with provider tag); second serves cache', async () => {
  const db = freshDb()
  const lemmaId = addLemma(db, 'kot')
  const provider = countingProvider()
  const input = { lemmaId, lemma: 'kot', pos: 'NOUN', sentence: 'Mam kota.' }

  const first = await getGloss(db, input, provider)
  expect(first).toEqual({ italian: 'IT:kot', cached: false })
  expect(provider.calls).toBe(1)

  const second = await getGloss(db, input, provider)
  expect(second).toEqual({ italian: 'IT:kot', cached: true })
  expect(provider.calls).toBe(1) // zero extra calls on cache hit

  const [row] = db.select().from(schema.gloss).all()
  expect(row.provider).toBe('stub')
})

test('no sentence context: never generates or caches, returns null', async () => {
  const db = freshDb()
  const lemmaId = addLemma(db, 'pies')
  const provider = countingProvider()

  const res = await getGloss(
    db,
    { lemmaId, lemma: 'pies', pos: 'NOUN', sentence: '   ' },
    provider,
  )
  expect(res).toEqual({ italian: null, cached: false })
  expect(provider.calls).toBe(0)
  expect(db.select().from(schema.gloss).all()).toHaveLength(0)
})

test('no-context caller still reads an existing cached gloss', async () => {
  const db = freshDb()
  const lemmaId = addLemma(db, 'dom')
  const provider = countingProvider()
  await getGloss(db, { lemmaId, lemma: 'dom', pos: 'NOUN', sentence: 'To dom.' }, provider)

  const res = await getGloss(
    db,
    { lemmaId, lemma: 'dom', pos: 'NOUN', sentence: '' },
    provider,
  )
  expect(res).toEqual({ italian: 'IT:dom', cached: true })
  expect(provider.calls).toBe(1)
})

test('manual gloss overrides a cached machine gloss and is not regenerated over', async () => {
  const db = freshDb()
  const lemmaId = addLemma(db, 'rzecz')
  const provider = countingProvider()
  const input = { lemmaId, lemma: 'rzecz', pos: 'NOUN', sentence: 'Ciekawe rzeczy.' }

  await getGloss(db, input, provider) // machine gloss cached
  setManualGloss(db, lemmaId, '  cosa  ')

  // A no-context read now serves the manual value, tagged 'manual'.
  const res = await getGloss(db, { ...input, sentence: '' }, provider)
  expect(res).toEqual({ italian: 'cosa', cached: true })
  const [row] = db.select().from(schema.gloss).all()
  expect(row.provider).toBe('manual')

  // getGloss with context must NOT overwrite the manual gloss.
  const still = await getGloss(db, input, provider)
  expect(still.italian).toBe('cosa')
})

test('setManualGloss rejects empty input', () => {
  const db = freshDb()
  const lemmaId = addLemma(db, 'pies')
  expect(() => setManualGloss(db, lemmaId, '   ')).toThrow()
})

test('regenerate discards even a manual gloss and generates fresh', async () => {
  const db = freshDb()
  const lemmaId = addLemma(db, 'kot')
  const provider = countingProvider()
  setManualGloss(db, lemmaId, 'gatto-vecchio')

  const res = await regenerateGloss(
    db,
    { lemmaId, lemma: 'kot', pos: 'NOUN', sentence: 'Mam kota.' },
    provider,
  )
  expect(res).toEqual({ italian: 'IT:kot', cached: false })
  expect(provider.calls).toBe(1)
})

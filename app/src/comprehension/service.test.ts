import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, test } from 'vitest'
import * as schema from '#/db/schema'
import type { GlossProvider } from '#/llm/provider'
import { getComprehensionCheck, regenerateComprehensionCheck } from './service'

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'drizzle' })
  return db
}

function addText(db: ReturnType<typeof freshDb>, content: string) {
  const [{ id }] = db
    .insert(schema.sourceText)
    .values({ title: 't', content })
    .returning({ id: schema.sourceText.id })
    .all()
  return id
}

function checkProvider() {
  return {
    name: 'stub',
    calls: 0,
    async gloss() {
      return 'unused'
    },
    async comprehension(req) {
      this.calls++
      return {
        questions: [
          {
            question: `Q1 (${req.text.length})?`,
            choices: ['giusta', 'sbagliata A', 'sbagliata B'],
            correctIndex: 0,
          },
          {
            question: 'Q2?',
            choices: ['a', 'b', 'c', 'd'],
            correctIndex: 3,
          },
        ],
      }
    },
  } satisfies GlossProvider & { calls: number }
}

test('first call generates + caches (provider tagged); second serves cache', async () => {
  const db = freshDb()
  const textId = addText(db, 'Mam kota.')
  const provider = checkProvider()

  const first = await getComprehensionCheck(db, textId, provider)
  expect(first.cached).toBe(false)
  expect(first.questions).toHaveLength(2)
  expect(first.questions[1].correctIndex).toBe(3)
  expect(provider.calls).toBe(1)

  const second = await getComprehensionCheck(db, textId, provider)
  expect(second).toEqual({ ...first, cached: true })
  expect(provider.calls).toBe(1) // zero extra calls on cache hit

  const rows = db.select().from(schema.comprehensionQuestion).all()
  expect(rows).toHaveLength(2)
  expect(rows[0].provider).toBe('stub')
})

test('throwing provider caches nothing', async () => {
  const db = freshDb()
  const textId = addText(db, 'To pies.')
  const provider = {
    name: 'stub',
    async gloss() {
      return 'unused'
    },
    async comprehension() {
      throw new Error('boom')
    },
  } satisfies GlossProvider

  await expect(getComprehensionCheck(db, textId, provider)).rejects.toThrow('boom')
  expect(db.select().from(schema.comprehensionQuestion).all()).toHaveLength(0)
})

test('provider without comprehension capability throws, caches nothing', async () => {
  const db = freshDb()
  const textId = addText(db, 'To dom.')
  const provider = {
    name: 'stub',
    async gloss() {
      return 'unused'
    },
  } satisfies GlossProvider

  await expect(getComprehensionCheck(db, textId, provider)).rejects.toThrow(
    /does not support/,
  )
  expect(db.select().from(schema.comprehensionQuestion).all()).toHaveLength(0)
})

test('missing text throws', async () => {
  const db = freshDb()
  await expect(getComprehensionCheck(db, 999, checkProvider())).rejects.toThrow(
    /not found/,
  )
})

test('concurrent first calls both resolve; one question set cached (StrictMode race)', async () => {
  const db = freshDb()
  const textId = addText(db, 'Ala ma kota.')
  const provider = checkProvider()

  // Both calls pass the cache check before either writes (the doubled-effect
  // race): the loser's insert must not throw on the unique index.
  const [a, b] = await Promise.all([
    getComprehensionCheck(db, textId, provider),
    getComprehensionCheck(db, textId, provider),
  ])
  expect(a.questions).toEqual(b.questions)
  expect(db.select().from(schema.comprehensionQuestion).all()).toHaveLength(2)
})

test('regenerate deletes cached rows and re-calls the provider', async () => {
  const db = freshDb()
  const textId = addText(db, 'Zamek w drzwiach.')
  const provider = checkProvider()

  await getComprehensionCheck(db, textId, provider)
  expect(provider.calls).toBe(1)

  const res = await regenerateComprehensionCheck(db, textId, provider)
  expect(res.cached).toBe(false)
  expect(provider.calls).toBe(2)
  expect(db.select().from(schema.comprehensionQuestion).all()).toHaveLength(2)
})

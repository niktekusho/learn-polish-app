import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, test } from 'vitest'
import * as schema from '#/db/schema'
import { persistAnalysis } from '#/import/pipeline'
import type { AnalyzeResponse } from '#/import/sidecar'
import { clearSourceTexts, getStats, pruneOrphanLemmas, purgeStubGlosses } from './ops'

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'drizzle' })
  return db
}

function w(surface: string, lemma: string, pos: string) {
  return { surface, lemma, pos, tags: [], is_space: false }
}

const ANALYSIS: AnalyzeResponse = {
  sentences: [{ tokens: [w('Robię', 'robić', 'VERB'), w('obiad', 'obiad', 'NOUN')] }],
}

test('clearing texts keeps glossed and reviewed lemmas; prune drops the rest', () => {
  const db = freshDb()
  persistAnalysis(db, { content: 'Robię obiad' }, ANALYSIS)

  // "robić" is translated (real provider), "obiad" also stub-glossed elsewhere.
  const robic = db.select().from(schema.lemma).all().find((l) => l.lemma === 'robić')!
  db.insert(schema.gloss)
    .values({ lemmaId: robic.id, italian: 'fare', provider: 'claude-cli' })
    .run()

  expect(clearSourceTexts(db)).toBe(1)
  expect(db.select().from(schema.token).all()).toHaveLength(0)
  // Both lemmas + knowledge survive the text wipe.
  expect(db.select().from(schema.lemma).all()).toHaveLength(2)
  expect(db.select().from(schema.knowledge).all()).toHaveLength(2)
  expect(db.select().from(schema.gloss).all()).toHaveLength(1)

  // Prune drops only "obiad" (no gloss, no reviews); "robić" keeps its gloss.
  expect(pruneOrphanLemmas(db)).toBe(1)
  const left = db.select().from(schema.lemma).all()
  expect(left.map((l) => l.lemma)).toEqual(['robić'])
  expect(db.select().from(schema.knowledge).all()).toHaveLength(1)
})

test('purgeStubGlosses removes only stub rows', () => {
  const db = freshDb()
  persistAnalysis(db, { content: 'Robię obiad' }, ANALYSIS)
  const [a, b] = db.select().from(schema.lemma).all()
  db.insert(schema.gloss).values({ lemmaId: a.id, italian: 'x', provider: 'stub' }).run()
  db.insert(schema.gloss)
    .values({ lemmaId: b.id, italian: 'y', provider: 'claude-cli' })
    .run()

  expect(purgeStubGlosses(db)).toBe(1)
  expect(getStats(db).glosses).toBe(1)
  expect(getStats(db).stubGlosses).toBe(0)
})

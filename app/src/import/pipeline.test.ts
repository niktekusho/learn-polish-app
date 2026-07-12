import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, test } from 'vitest'
import * as schema from '#/db/schema'
import { persistAnalysis } from './pipeline'
import type { AnalyzeResponse } from './sidecar'

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'drizzle' })
  return db
}

function sp(surface: string) {
  return { surface, lemma: surface, pos: 'SPACE', tags: [], is_space: true }
}
function w(surface: string, lemma: string, pos: string) {
  return { surface, lemma, pos, tags: [], is_space: false }
}

// "Robię obiad w kuchni." analyzed (matches the sidecar's #2 acceptance).
const ANALYSIS: AnalyzeResponse = {
  sentences: [
    {
      tokens: [
        w('Robię', 'robić', 'VERB'),
        sp(' '),
        w('obiad', 'obiad', 'NOUN'),
        sp(' '),
        w('w', 'w', 'ADP'),
        sp(' '),
        w('kuchni', 'kuchnia', 'NOUN'),
        w('.', '.', 'PUNCT'),
      ],
    },
  ],
}

test('import creates one text, all tokens, and distinct lemmas with knowledge', () => {
  const db = freshDb()
  const res = persistAnalysis(db, { content: 'Robię obiad w kuchni.' }, ANALYSIS)

  expect(res.tokenCount).toBe(8)
  expect(res.lemmaCount).toBe(4)

  expect(db.select().from(schema.sourceText).all()).toHaveLength(1)
  expect(db.select().from(schema.token).all()).toHaveLength(8)

  const lemmas = db
    .select()
    .from(schema.lemma)
    .all()
    .map((l) => l.lemma)
    .sort()
  expect(lemmas).toEqual(['kuchnia', 'obiad', 'robić', 'w'])

  const know = db.select().from(schema.knowledge).all()
  expect(know).toHaveLength(4)
  expect(know.every((k) => k.track === 'receptive' && k.state === 0)).toBe(true)

  const punct = db
    .select()
    .from(schema.token)
    .all()
    .find((t) => t.surface === '.')
  expect(punct?.lemmaId).toBeNull()
})

test('re-importing links to existing lemmas without duplicating them', () => {
  const db = freshDb()
  persistAnalysis(db, { content: 'x' }, ANALYSIS)
  persistAnalysis(db, { content: 'x' }, ANALYSIS)

  expect(db.select().from(schema.sourceText).all()).toHaveLength(2)
  expect(db.select().from(schema.token).all()).toHaveLength(16)
  expect(db.select().from(schema.lemma).all()).toHaveLength(4)
  expect(db.select().from(schema.knowledge).all()).toHaveLength(4)
})

test('detected MWEs become pos=MWE tracked units with occurrences', () => {
  const db = freshDb()
  // "Na pewno tak."
  const analysis: AnalyzeResponse = {
    sentences: [
      {
        tokens: [
          w('Na', 'na', 'ADP'),
          sp(' '),
          w('pewno', 'pewno', 'ADV'),
          sp(' '),
          w('tak', 'tak', 'PART'),
          w('.', '.', 'PUNCT'),
        ],
      },
    ],
  }
  const headwords = new Map([['na', ['na pewno']]])
  const res = persistAnalysis(
    db,
    { content: 'Na pewno tak.' },
    analysis,
    new Date(),
    headwords,
  )
  expect(res.mweCount).toBe(1)

  const mweLemma = db
    .select()
    .from(schema.lemma)
    .all()
    .find((l) => l.pos === 'MWE')
  expect(mweLemma?.lemma).toBe('na pewno')

  const know = db
    .select()
    .from(schema.knowledge)
    .all()
    .find((k) => k.lemmaId === mweLemma?.id)
  expect(know?.track).toBe('receptive')

  const [occ] = db.select().from(schema.mweOccurrence).all()
  expect(occ.lemmaId).toBe(mweLemma?.id)
  expect(occ.startPosition).toBe(0)
  expect(occ.endPosition).toBe(2) // 'pewno' sits at position 2 (space at 1)
  expect(occ.sentenceIndex).toBe(0)
})

test('no headwords: zero MWE occurrences, pipeline unchanged', () => {
  const db = freshDb()
  const res = persistAnalysis(
    db,
    { content: 'x' },
    ANALYSIS,
    new Date(),
    new Map(),
  )
  expect(res.mweCount).toBe(0)
  expect(db.select().from(schema.mweOccurrence).all()).toHaveLength(0)
})

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, test } from 'vitest'
import * as schema from '#/db/schema'
import { Rating, gradeLemma, initialKnowledgeFields } from '#/fsrs/index'
import { isReceptiveKnown, isStillLearning } from './knowledge'
import { markNewKnown } from './mark'

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'drizzle' })
  return db
}

function addWord(db: ReturnType<typeof freshDb>, textId: number, word: string) {
  const [{ id: lemmaId }] = db
    .insert(schema.lemma)
    .values({ lemma: word, pos: 'NOUN' })
    .returning({ id: schema.lemma.id })
    .all()
  db.insert(schema.knowledge)
    .values({ lemmaId, track: 'receptive', ...initialKnowledgeFields() })
    .run()
  db.insert(schema.token)
    .values({ textId, lemmaId, surface: word, position: lemmaId, sentenceIndex: 0 })
    .run()
  return lemmaId
}

test('batch marks only never-touched (New) words, skipping "still learning"', () => {
  const db = freshDb()
  const [{ id: textId }] = db
    .insert(schema.sourceText)
    .values({ content: 'x' })
    .returning({ id: schema.sourceText.id })
    .all()

  const fresh1 = addWord(db, textId, 'nowy1')
  const fresh2 = addWord(db, textId, 'nowy2')
  const learning = addWord(db, textId, 'uczony')

  // User explicitly marked one word "still learning" (Again -> Learning).
  gradeLemma(db, learning, 'receptive', Rating.Again)

  const affected = markNewKnown(db, textId)

  expect(affected.sort()).toEqual([fresh1, fresh2].sort())
  expect(affected).not.toContain(learning)

  const byId = Object.fromEntries(
    db
      .select()
      .from(schema.knowledge)
      .all()
      .map((k) => [k.lemmaId, k.state]),
  )
  expect(isReceptiveKnown(byId[fresh1])).toBe(true)
  expect(isReceptiveKnown(byId[fresh2])).toBe(true)
  // The explicit "still learning" word is untouched by the batch.
  expect(isStillLearning(byId[learning])).toBe(true)
  expect(isReceptiveKnown(byId[learning])).toBe(false)
})

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, test } from 'vitest'
import * as schema from '#/db/schema'
import { initialKnowledgeFields } from '#/fsrs/index'
import { answerItem, buildSession, resumeSession } from './session'

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'drizzle' })
  return db
}

// Seed a due lemma; give it a cached gloss unless gloss === null.
function seed(
  db: ReturnType<typeof freshDb>,
  word: string,
  glossText: string | null,
) {
  const due = new Date('2026-01-01T00:00:00Z')
  const [{ id }] = db
    .insert(schema.lemma)
    .values({ lemma: word, pos: 'NOUN' })
    .returning({ id: schema.lemma.id })
    .all()
  db.insert(schema.knowledge)
    .values({ lemmaId: id, track: 'receptive', ...initialKnowledgeFields(due) })
    .run()
  if (glossText !== null) {
    db.insert(schema.gloss).values({ lemmaId: id, italian: glossText }).run()
  }
  return id
}

test('buildSession skips un-glossed lemmas and never generates a gloss', () => {
  const db = freshDb()
  seed(db, 'kot', 'gatto')
  seed(db, 'pies', 'cane')
  seed(db, 'dom', 'casa')
  seed(db, 'woda', 'acqua')
  seed(db, 'bezglosu', null) // due but no cached gloss -> skipped

  const glossesBefore = db.select().from(schema.gloss).all().length
  const session = buildSession(db, { limit: 20 })

  // 4 glossed lemmas -> 4 items; the un-glossed one is skipped.
  expect(session.items).toHaveLength(4)
  // Zero gloss generation in session build (#10/#6).
  expect(db.select().from(schema.gloss).all()).toHaveLength(glossesBefore)
  // Client items carry no correct-answer marker.
  for (const item of session.items) {
    expect('correctIndex' in item).toBe(false)
    expect(item.choices).toHaveLength(4)
  }
})

test('answering grades exactly once; a repeat submit is rejected', () => {
  const db = freshDb()
  for (const [w, g] of [
    ['kot', 'gatto'],
    ['pies', 'cane'],
    ['dom', 'casa'],
    ['woda', 'acqua'],
  ] as const) {
    seed(db, w, g)
  }
  const session = buildSession(db, { limit: 20 })
  const first = session.items[0]

  const r1 = answerItem(db, session.sessionId, first.id, 0)
  expect(r1.alreadyAnswered).toBe(false)
  expect(db.select().from(schema.reviewLog).all()).toHaveLength(1)

  // Repeat submit for the same item: no second FSRS update / review_log row.
  const r2 = answerItem(db, session.sessionId, first.id, 1)
  expect(r2.alreadyAnswered).toBe(true)
  expect(r2.correct).toBe(r1.correct)
  expect(db.select().from(schema.reviewLog).all()).toHaveLength(1)
})

test('resumeSession returns the held items and answered progress', () => {
  const db = freshDb()
  for (const [w, g] of [
    ['kot', 'gatto'],
    ['pies', 'cane'],
    ['dom', 'casa'],
    ['woda', 'acqua'],
  ] as const) {
    seed(db, w, g)
  }
  const session = buildSession(db, { limit: 20 })
  answerItem(db, session.sessionId, session.items[0].id, 0)

  const resumed = resumeSession(session.sessionId)
  expect(resumed).not.toBeNull()
  expect(resumed?.items).toHaveLength(session.items.length)
  expect(resumed?.answered).toHaveLength(1)
  expect(resumeSession('nope')).toBeNull()
})

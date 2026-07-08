import { eq } from 'drizzle-orm'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, test } from 'vitest'
import * as schema from './schema'

// Fresh in-memory DB with the real migrations applied. Proves the schema
// migrates clean (#3 acceptance) without touching the dev app.db.
function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'drizzle' })
  return db
}

test('a lemma carries two independent FSRS track states', () => {
  const db = freshDb()

  const [{ id: lemmaId }] = db
    .insert(schema.lemma)
    .values({ lemma: 'kot', pos: 'NOUN' })
    .returning({ id: schema.lemma.id })
    .all()

  db.insert(schema.knowledge)
    .values([
      { lemmaId, track: 'receptive', stability: 1.5, state: 2 },
      { lemmaId, track: 'productive', stability: 0, state: 0 },
    ])
    .run()

  const rows = db
    .select()
    .from(schema.knowledge)
    .where(eq(schema.knowledge.lemmaId, lemmaId))
    .all()

  expect(rows).toHaveLength(2)
  const byTrack = Object.fromEntries(rows.map((r) => [r.track, r]))
  expect(byTrack.receptive.stability).toBe(1.5)
  expect(byTrack.receptive.state).toBe(2)
  expect(byTrack.productive.state).toBe(0)
  expect(byTrack.receptive.id).not.toBe(byTrack.productive.id)
})

test('the (lemma, track) pair is unique', () => {
  const db = freshDb()
  const [{ id: lemmaId }] = db
    .insert(schema.lemma)
    .values({ lemma: 'pies', pos: 'NOUN' })
    .returning({ id: schema.lemma.id })
    .all()

  db.insert(schema.knowledge).values({ lemmaId, track: 'receptive' }).run()
  expect(() =>
    db.insert(schema.knowledge).values({ lemmaId, track: 'receptive' }).run(),
  ).toThrow()
})

test('review_log records an append-only grade history row', () => {
  const db = freshDb()
  const [{ id: lemmaId }] = db
    .insert(schema.lemma)
    .values({ lemma: 'dom', pos: 'NOUN' })
    .returning({ id: schema.lemma.id })
    .all()

  db.insert(schema.reviewLog)
    .values({
      lemmaId,
      track: 'receptive',
      rating: 3,
      stateBefore: 0,
      stateAfter: 1,
    })
    .run()

  const [row] = db.select().from(schema.reviewLog).all()
  expect(row.rating).toBe(3)
  expect(row.stateBefore).toBe(0)
  expect(row.stateAfter).toBe(1)
  expect(row.reviewedAt).toBeInstanceOf(Date)
})

test('gloss rows carry a provider, defaulting to stub', () => {
  const db = freshDb()
  const [{ id: lemmaId }] = db
    .insert(schema.lemma)
    .values({ lemma: 'woda', pos: 'NOUN' })
    .returning({ id: schema.lemma.id })
    .all()
  db.insert(schema.gloss).values({ lemmaId, italian: 'acqua' }).run()
  const [row] = db.select().from(schema.gloss).all()
  expect(row.provider).toBe('stub')
})

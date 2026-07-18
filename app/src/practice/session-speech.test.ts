import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { beforeEach, expect, test, vi } from 'vitest'
import * as schema from '#/db/schema'
import { initialKnowledgeFields } from '#/fsrs/index'
import {
  answerSpeechItem,
  buildSession,
  revealItem,
  selfGradeItem,
} from './session'

// Speech grading calls the sidecar; tests stub it (the real roundtrip is
// covered by sidecar/test_transcribe.py).
vi.mock('#/import/sidecar', () => ({
  transcribe: vi.fn(),
  analyze: vi.fn(),
}))
import { analyze, transcribe } from '#/import/sidecar'

beforeEach(() => {
  vi.mocked(transcribe).mockReset()
  vi.mocked(analyze).mockReset()
})

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'drizzle' })
  return db
}

function seed(db: ReturnType<typeof freshDb>, word: string, glossText: string) {
  const due = new Date('2026-01-01T00:00:00Z')
  const [{ id }] = db
    .insert(schema.lemma)
    .values({ lemma: word, pos: 'NOUN' })
    .returning({ id: schema.lemma.id })
    .all()
  db.insert(schema.knowledge)
    .values({ lemmaId: id, track: 'receptive', ...initialKnowledgeFields(due) })
    .run()
  db.insert(schema.gloss).values({ lemmaId: id, italian: glossText }).run()
  return id
}

function seedFour(db: ReturnType<typeof freshDb>) {
  for (const [w, g] of [
    ['kot', 'gatto'],
    ['pies', 'cane'],
    ['dom', 'casa'],
    ['woda', 'acqua'],
  ] as const) {
    seed(db, w, g)
  }
}

const asAudio = () => new Blob(['x'], { type: 'audio/ogg' })

function mockTranscript(text: string, lemmas: string[]) {
  vi.mocked(transcribe).mockResolvedValue(text)
  vi.mocked(analyze).mockResolvedValue({
    sentences: [
      {
        tokens: lemmas.map((l) => ({
          surface: l,
          lemma: l,
          pos: 'NOUN',
          tags: [],
          is_space: false,
        })),
      },
    ],
  })
}

test('mic on: productive cards seeded, spoken-recall items lead the mix', () => {
  const db = freshDb()
  seedFour(db)

  const session = buildSession(db, { limit: 20, mic: true })

  const productiveRows = db
    .select()
    .from(schema.knowledge)
    .all()
    .filter((k) => k.track === 'productive')
  expect(productiveRows).toHaveLength(4) // every glossed lemma got a New productive card

  const kinds = session.items.map((i) => i.kind)
  expect(kinds.filter((k) => k === 'spoken-recall')).toHaveLength(4)
  // weakest-track-first: speaking items come before the receptive MCQs
  expect(kinds.slice(0, 4).every((k) => k === 'spoken-recall')).toBe(true)
  // spoken items never leak the answer
  for (const item of session.items) {
    if (item.kind === 'spoken-recall') expect('lemma' in item).toBe(false)
  }
})

test('PROPN gets no productive card and no spoken-recall item', () => {
  const db = freshDb()
  seedFour(db)
  // a glossed proper noun, due like everything else
  const due = new Date('2026-01-01T00:00:00Z')
  const [{ id }] = db
    .insert(schema.lemma)
    .values({ lemma: 'Ola', pos: 'PROPN' })
    .returning({ id: schema.lemma.id })
    .all()
  db.insert(schema.knowledge)
    .values({ lemmaId: id, track: 'receptive', ...initialKnowledgeFields(due) })
    .run()
  db.insert(schema.gloss).values({ lemmaId: id, italian: 'prontuario (nome proprio)' }).run()

  const session = buildSession(db, { limit: 20, mic: true })

  const productiveRows = db
    .select()
    .from(schema.knowledge)
    .all()
    .filter((k) => k.track === 'productive')
  expect(productiveRows.map((k) => k.lemmaId)).not.toContain(id) // not seeded
  expect(productiveRows).toHaveLength(4) // the four common nouns only
  // ...but the proper noun still practices receptively (MCQ)
  expect(session.items.filter((i) => i.kind === 'spoken-recall')).toHaveLength(4)
  expect(session.items.filter((i) => i.kind === 'recognition-mcq')).toHaveLength(5)
})

test('mic off: no productive seeding, no speaking items', () => {
  const db = freshDb()
  seedFour(db)
  const session = buildSession(db, { limit: 20, mic: false })
  expect(session.items.every((i) => i.kind === 'recognition-mcq')).toBe(true)
  const productiveRows = db
    .select()
    .from(schema.knowledge)
    .all()
    .filter((k) => k.track === 'productive')
  expect(productiveRows).toHaveLength(0)
})

test('ASR hit grades productive Good immediately, exactly once', async () => {
  const db = freshDb()
  seedFour(db)
  const session = buildSession(db, { limit: 20, mic: true })
  const spoken = session.items.find((i) => i.kind === 'spoken-recall')
  if (!spoken || spoken.kind !== 'spoken-recall') throw new Error('no spoken item')

  // The item's answer is server-held; figure out the target via its gloss.
  const target = { gatto: 'kot', cane: 'pies', casa: 'dom', acqua: 'woda' }[
    spoken.gloss
  ] as string
  mockTranscript(target, [target])

  const res = await answerSpeechItem(db, session.sessionId, spoken.id, asAudio())
  expect(res.status).toBe('correct')
  const logs = db.select().from(schema.reviewLog).all()
  expect(logs).toHaveLength(1)
  expect(logs[0].track).toBe('productive')

  // replay: no second write
  const res2 = await answerSpeechItem(db, session.sessionId, spoken.id, asAudio())
  expect(res2.status).toBe('alreadyAnswered')
  expect(db.select().from(schema.reviewLog).all()).toHaveLength(1)
})

test('ASR miss writes no FSRS; self-grade does, exactly once', async () => {
  const db = freshDb()
  seedFour(db)
  const session = buildSession(db, { limit: 20, mic: true })
  const spoken = session.items.find((i) => i.kind === 'spoken-recall')
  if (!spoken || spoken.kind !== 'spoken-recall') throw new Error('no spoken item')

  mockTranscript('zupełnie co innego', ['zupełnie', 'co', 'inny'])
  const res = await answerSpeechItem(db, session.sessionId, spoken.id, asAudio())
  expect(res.status).toBe('miss')
  expect(res.answer).toBeTruthy() // reveal
  expect(db.select().from(schema.reviewLog).all()).toHaveLength(0) // no write yet

  const g1 = selfGradeItem(db, session.sessionId, spoken.id, true)
  expect(g1.alreadyAnswered).toBe(false)
  expect(db.select().from(schema.reviewLog).all()).toHaveLength(1)

  const g2 = selfGradeItem(db, session.sessionId, spoken.id, false)
  expect(g2.alreadyAnswered).toBe(true)
  expect(db.select().from(schema.reviewLog).all()).toHaveLength(1)
})

/** Give a lemma a sentence occurrence so read-aloud applies to it. */
function seedSentence(
  db: ReturnType<typeof freshDb>,
  lemmaId: number,
  words: string[],
) {
  const [{ id: textId }] = db
    .insert(schema.sourceText)
    .values({ content: words.join(' ') })
    .returning({ id: schema.sourceText.id })
    .all()
  db.insert(schema.token)
    .values(
      words.map((w, i) => ({
        textId,
        lemmaId: i === 0 ? lemmaId : null, // target sits at position 0
        surface: i < words.length - 1 ? `${w} ` : w,
        position: i,
        sentenceIndex: 0,
      })),
    )
    .run()
}

test('mic on: receptive due with a sentence renders as read-aloud (rng-forced)', async () => {
  const db = freshDb()
  seedFour(db)
  const kotId = db
    .select()
    .from(schema.lemma)
    .all()
    .find((l) => l.lemma === 'kot')!.id
  seedSentence(db, kotId, ['Kot', 'pije', 'wodę.'])

  // rng always < 0.5 -> read-aloud whenever a sentence exists
  const session = buildSession(db, { limit: 20, mic: true, rng: () => 0 })
  const ra = session.items.find((i) => i.kind === 'read-aloud')
  expect(ra).toBeTruthy()
  if (!ra || ra.kind !== 'read-aloud') throw new Error('unreachable')
  expect(ra.sentence).toBe('Kot pije wodę.')
  expect('lemma' in ra).toBe(false) // graded word stays server-side

  // grading writes the receptive track only
  mockTranscript('kot pije wodę', ['kot', 'pić', 'woda'])
  const res = await answerSpeechItem(db, session.sessionId, ra.id, asAudio())
  expect(res.status).toBe('correct')
  const logs = db.select().from(schema.reviewLog).all()
  expect(logs).toHaveLength(1)
  expect(logs[0].track).toBe('receptive')
  expect(logs[0].lemmaId).toBe(kotId)
})

test('mic on but no sentence: receptive due falls back to MCQ', () => {
  const db = freshDb()
  seedFour(db)
  const session = buildSession(db, { limit: 20, mic: true, rng: () => 0 })
  // nobody has token occurrences -> zero read-aloud, receptive dues all MCQ
  expect(session.items.some((i) => i.kind === 'read-aloud')).toBe(false)
  expect(session.items.filter((i) => i.kind === 'recognition-mcq')).toHaveLength(4)
})

test('reveal (give-up) grades nothing until self-grade', () => {
  const db = freshDb()
  seedFour(db)
  const session = buildSession(db, { limit: 20, mic: true })
  const spoken = session.items.find((i) => i.kind === 'spoken-recall')
  if (!spoken || spoken.kind !== 'spoken-recall') throw new Error('no spoken item')

  const { answer } = revealItem(session.sessionId, spoken.id)
  expect(answer).toBeTruthy()
  expect(db.select().from(schema.reviewLog).all()).toHaveLength(0)

  selfGradeItem(db, session.sessionId, spoken.id, false)
  const logs = db.select().from(schema.reviewLog).all()
  expect(logs).toHaveLength(1)
  expect(logs[0].rating).toBe(1) // Again
})

import { and, asc, eq, isNull, ne } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '#/db/schema'
import { gloss, knowledge, lemma, token } from '#/db/schema'
import type {
  ReadAloudClientItem,
  ReadAloudItem,
} from '#/exercises/read-aloud'
import { readAloud } from '#/exercises/read-aloud'
import type {
  McqClientItem,
  McqItem,
} from '#/exercises/recognition-mcq'
import { recognitionMcq } from '#/exercises/recognition-mcq'
import type {
  SpokenRecallClientItem,
  SpokenRecallItem,
  SpokenResponse,
} from '#/exercises/spoken-recall'
import { spokenRecall } from '#/exercises/spoken-recall'
import type { ExerciseCandidate } from '#/exercises/types'
import { Rating, dueLemmas, gradeLemma, initialKnowledgeFields } from '#/fsrs/index'
import { analyze, transcribe } from '#/import/sidecar'

type DB = BetterSQLite3Database<typeof schema>

/** Server-held item, tagged with the exercise that generated (and grades) it. */
type StoredItem =
  | { exercise: 'recognition-mcq'; item: McqItem }
  | { exercise: 'spoken-recall'; item: SpokenRecallItem }
  | { exercise: 'read-aloud'; item: ReadAloudItem }

/** The speak-answer exercises share the audio answer/reveal/self-grade flow. */
const speechExercises = {
  'spoken-recall': spokenRecall,
  'read-aloud': readAloud,
} as const
type SpeechStored = Extract<StoredItem, { exercise: keyof typeof speechExercises }>

export type ClientPracticeItem =
  | ({ kind: 'recognition-mcq' } & McqClientItem)
  | SpokenRecallClientItem
  | ReadAloudClientItem

interface StoredSession {
  id: string
  items: StoredItem[] // full items, held server-side (carry the answer)
  answered: Map<string, boolean> // itemId -> was correct
}

// ponytail: in-memory, single-user. A reload resumes via the session id; a
// server restart drops sessions and the client just starts a fresh one. Move to
// a table only if persistent/multi-device resume is ever needed.
const sessions = new Map<string, StoredSession>()

export interface ClientSession {
  sessionId: string
  items: ClientPracticeItem[] // answer-free projections
  answered: { itemId: string; correct: boolean }[]
}

function toClientItem(s: StoredItem): ClientPracticeItem {
  switch (s.exercise) {
    case 'recognition-mcq':
      return { kind: 'recognition-mcq', ...recognitionMcq.toClient(s.item) }
    case 'spoken-recall':
      return spokenRecall.toClient(s.item)
    case 'read-aloud':
      return readAloud.toClient(s.item)
  }
}

/**
 * Shortest imported sentence containing the lemma — read-aloud fuel. Checks a
 * handful of occurrences; shortest wins (least ASR noise). undefined when the
 * lemma has no token occurrence (e.g. MWEs, whose occurrences live elsewhere).
 */
function sentenceFor(db: DB, lemmaId: number): string | undefined {
  const occs = db
    .selectDistinct({ textId: token.textId, sentenceIndex: token.sentenceIndex })
    .from(token)
    .where(eq(token.lemmaId, lemmaId))
    .limit(5)
    .all()
  let best: string | undefined
  for (const o of occs) {
    const parts = db
      .select({ surface: token.surface })
      .from(token)
      .where(
        and(eq(token.textId, o.textId), eq(token.sentenceIndex, o.sentenceIndex)),
      )
      .orderBy(asc(token.position))
      .all()
    const s = parts.map((p) => p.surface).join('').trim()
    if (s && (!best || s.length < best.length)) best = s
  }
  return best
}

/** Glossed lemmas only — exercise targets + MCQ distractor source. */
function glossedCandidates(db: DB): ExerciseCandidate[] {
  return db
    .select({
      lemmaId: lemma.id,
      lemma: lemma.lemma,
      pos: lemma.pos,
      gloss: gloss.italian,
    })
    .from(lemma)
    .innerJoin(gloss, and(eq(gloss.lemmaId, lemma.id), eq(gloss.sense, '')))
    .all()
}

/**
 * Backfill productive knowledge rows for glossed lemmas that lack one. Import
 * seeds receptive only; the productive track starts here, at speaking-session
 * build (roadmap Slice 1: no maturity gate — any glossed lemma becomes a New
 * productive card; `newCardLimit` throttles the flood).
 */
function seedProductiveCards(db: DB, now = new Date()) {
  const missing = db
    .select({ lemmaId: lemma.id })
    .from(lemma)
    .innerJoin(gloss, and(eq(gloss.lemmaId, lemma.id), eq(gloss.sense, '')))
    .leftJoin(
      knowledge,
      and(eq(knowledge.lemmaId, lemma.id), eq(knowledge.track, 'productive')),
    )
    // PROPN never gets a productive card — spoken recall (the only productive
    // exercise) excludes it, so a card would sit due forever, never rendered.
    .where(and(isNull(knowledge.id), ne(lemma.pos, 'PROPN')))
    .all()
  if (missing.length === 0) return
  const fields = initialKnowledgeFields(now)
  db.insert(knowledge)
    .values(
      missing.map(({ lemmaId }) => ({ lemmaId, track: 'productive' as const, ...fields })),
    )
    .run()
}

/**
 * Build a Practice session (#10): due lemmas rendered through the applicable
 * exercise, held server-side under a fresh id. With `mic` on, the productive
 * track joins the mix (weakest-track-first: productive dues lead — the track
 * is younger); mic off skips everything that needs speaking.
 *
 * NO gloss generation here: Practice has no sentence context (#6), so lemmas
 * without a cached gloss are simply skipped. Zero provider/LLM calls.
 */
export function buildSession(
  db: DB,
  {
    limit = 20,
    newCardLimit,
    mic = false,
    rng = Math.random,
  }: {
    limit?: number
    newCardLimit?: number
    mic?: boolean
    rng?: () => number
  } = {},
): ClientSession {
  const pool = glossedCandidates(db)
  const byId = new Map(pool.map((c) => [c.lemmaId, c]))
  const items: StoredItem[] = []

  if (mic) {
    seedProductiveCards(db)
    for (const d of dueLemmas(db, 'productive', { limit, newCardLimit })) {
      const target = byId.get(d.lemmaId)
      if (!target || !spokenRecall.appliesTo(target)) continue
      const item = spokenRecall.generate(target, pool)
      if (item) items.push({ exercise: 'spoken-recall', item })
    }
  }

  const remaining = Math.max(0, limit - items.length)
  for (const d of dueLemmas(db, 'receptive', { limit: remaining, newCardLimit })) {
    const target = byId.get(d.lemmaId)
    if (!target) continue // no cached gloss -> skip, never generate

    // With the mic on, a receptive due renders as read-aloud half the time
    // (ADR-0003 variety); MCQ is the fallback either way, and vice versa.
    const tryReadAloudFirst = mic && rng() < 0.5
    if (mic) target.sentence ??= sentenceFor(db, d.lemmaId)

    let pushed = false
    if (tryReadAloudFirst && readAloud.appliesTo(target)) {
      const item = readAloud.generate(target, pool)
      if (item) {
        items.push({ exercise: 'read-aloud', item })
        pushed = true
      }
    }
    if (!pushed) {
      const item = recognitionMcq.generate(target, pool)
      if (item) {
        items.push({ exercise: 'recognition-mcq', item })
        pushed = true
      }
    }
    if (!pushed && mic && readAloud.appliesTo(target)) {
      const item = readAloud.generate(target, pool)
      if (item) items.push({ exercise: 'read-aloud', item })
    }
  }

  const id = crypto.randomUUID()
  sessions.set(id, { id, items, answered: new Map() })
  return { sessionId: id, items: items.map(toClientItem), answered: [] }
}

/** Re-project a held session (reload/refocus resume). null if unknown/expired. */
export function resumeSession(sessionId: string): ClientSession | null {
  const s = sessions.get(sessionId)
  if (!s) return null
  return {
    sessionId,
    items: s.items.map(toClientItem),
    answered: [...s.answered].map(([itemId, correct]) => ({ itemId, correct })),
  }
}

function heldItem(sessionId: string, itemId: string): { s: StoredSession; stored: StoredItem } {
  const s = sessions.get(sessionId)
  if (!s) throw new Error('practice session not found')
  const stored = s.items.find((i) => i.item.id === itemId)
  if (!stored) throw new Error('item not in session')
  return { s, stored }
}

export interface AnswerResult {
  correct: boolean
  correctIndex: number
  alreadyAnswered: boolean // true = this item was already graded; FSRS untouched
}

/**
 * Grade one MCQ answer against the server-held item, exactly once. A repeat
 * submit for the same item is rejected (no second FSRS update) so a
 * double-click or replayed request can't advance scheduling twice.
 */
export function answerItem(
  db: DB,
  sessionId: string,
  itemId: string,
  choiceIndex: number,
): AnswerResult {
  const { s, stored } = heldItem(sessionId, itemId)
  if (stored.exercise !== 'recognition-mcq') throw new Error('not a choice item')
  const item = stored.item

  if (s.answered.has(itemId)) {
    return {
      correct: s.answered.get(itemId) as boolean,
      correctIndex: item.correctIndex,
      alreadyAnswered: true,
    }
  }

  const rating = recognitionMcq.grade(item, { choiceIndex })
  gradeLemma(db, item.lemmaId, 'receptive', rating)
  const correct = choiceIndex === item.correctIndex
  s.answered.set(itemId, correct)
  return { correct, correctIndex: item.correctIndex, alreadyAnswered: false }
}

export interface SpeechAnswerResult {
  status: 'correct' | 'miss' | 'alreadyAnswered'
  transcript: string
  /** The target, revealed on miss so the learner can self-grade. */
  answer?: string
}

/**
 * Grade a speaking answer. ASR hit writes FSRS (Good) immediately; a miss
 * writes NOTHING — whisper misfires on short non-native words, so the learner
 * sees the reveal + transcript and self-grades (selfGradeItem), which does the
 * write. The item stays unanswered until then.
 */
function asSpeechItem(stored: StoredItem): SpeechStored {
  if (!(stored.exercise in speechExercises)) throw new Error('not a speech item')
  return stored as SpeechStored
}

export async function answerSpeechItem(
  db: DB,
  sessionId: string,
  itemId: string,
  audio: Blob,
): Promise<SpeechAnswerResult> {
  const { s, stored } = heldItem(sessionId, itemId)
  const speech = asSpeechItem(stored)
  if (s.answered.has(itemId)) return { status: 'alreadyAnswered', transcript: '' }

  const text = (await transcribe(audio)).trim()
  const response: SpokenResponse = {
    transcriptText: text,
    transcriptLemmas: text ? await transcriptLemmas(text) : [],
  }

  const rating =
    speech.exercise === 'spoken-recall'
      ? spokenRecall.grade(speech.item, response)
      : readAloud.grade(speech.item, response)
  if (rating === Rating.Good) {
    for (const track of speechExercises[speech.exercise].tracks) {
      gradeLemma(db, speech.item.lemmaId, track, Rating.Good)
    }
    s.answered.set(itemId, true)
    return { status: 'correct', transcript: text }
  }
  return { status: 'miss', transcript: text, answer: speech.item.lemma }
}

/** Lemmatize an ASR transcript via the sidecar (words only, no punctuation). */
async function transcriptLemmas(text: string): Promise<string[]> {
  const analyzed = await analyze(text)
  return analyzed.sentences.flatMap((sent) =>
    sent.tokens
      .filter((t) => !t.is_space && t.pos !== 'PUNCT')
      .map((t) => t.lemma),
  )
}

/**
 * Reveal a speech item's answer without grading — the give-up / no-mic path.
 * The learner then self-grades, same as after an ASR miss.
 */
export function revealItem(sessionId: string, itemId: string): { answer: string } {
  const { stored } = heldItem(sessionId, itemId)
  return { answer: asSpeechItem(stored).item.lemma }
}

/**
 * Self-grade after a reveal ("said it" / "didn't"). This is where the FSRS
 * write for an ASR miss (or give-up) happens — exactly once, same guard as
 * answerItem.
 */
export function selfGradeItem(
  db: DB,
  sessionId: string,
  itemId: string,
  saidIt: boolean,
): { alreadyAnswered: boolean } {
  const { s, stored } = heldItem(sessionId, itemId)
  const speech = asSpeechItem(stored)
  if (s.answered.has(itemId)) return { alreadyAnswered: true }

  for (const track of speechExercises[speech.exercise].tracks) {
    gradeLemma(db, speech.item.lemmaId, track, saidIt ? Rating.Good : Rating.Again)
  }
  s.answered.set(itemId, saidIt)
  return { alreadyAnswered: false }
}

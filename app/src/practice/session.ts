import { and, asc, eq, exists, isNull, ne, notExists } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { alias } from 'drizzle-orm/sqlite-core'
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
import {
  type DueLemma,
  type Grade,
  Rating,
  dueLemmas,
  gradeLemma,
  initialKnowledgeFields,
} from '#/fsrs/index'
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

/**
 * Per speech item: what happened so far. Spoken recall's first attempt is
 * blind (retrieval); once `revealed`, every attempt is a **Visible attempt**
 * (CONTEXT.md). Read-aloud attempts are always visible. `misses`/`hit` count
 * visible attempts only — they become the Pronunciation rating (ADR-0005).
 */
interface SpeechAttempts {
  revealed: boolean
  misses: number
  hit: boolean
}

interface StoredSession {
  id: string
  items: StoredItem[] // full items, held server-side (carry the answer)
  answered: Map<string, boolean> // itemId -> was correct
  attempts: Map<string, SpeechAttempts> // speech items only
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
 * handful of occurrences; shortest wins (least ASR noise), but one not in
 * `avoid` beats any in it (no reading the same sentence 4× a session).
 * undefined when the lemma has no token occurrence (e.g. MWEs, whose
 * occurrences live elsewhere).
 */
function sentenceFor(db: DB, lemmaId: number, avoid = new Set<string>()): string | undefined {
  const occs = db
    .selectDistinct({ textId: token.textId, sentenceIndex: token.sentenceIndex })
    .from(token)
    .where(eq(token.lemmaId, lemmaId))
    .limit(5)
    .all()
  const score = (x: string) => (avoid.has(x) ? 1e6 : 0) + x.length // lower wins
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
    if (s && (!best || score(s) < score(best))) best = s
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
 * Backfill pronunciation rows (ADR-0005): a lemma joins the track after its
 * first receptive review (understand, then say, then recall), and only if it
 * has a token occurrence — read-aloud, the track's renderer, needs a sentence;
 * without one the card would sit due forever.
 */
function seedPronunciationCards(db: DB, now = new Date()) {
  const pron = alias(knowledge, 'pron')
  const missing = db
    .select({ lemmaId: knowledge.lemmaId })
    .from(knowledge)
    .where(
      and(
        eq(knowledge.track, 'receptive'),
        ne(knowledge.state, 0), // left New: reviewed at least once
        exists(
          db.select({ id: token.id }).from(token).where(eq(token.lemmaId, knowledge.lemmaId)),
        ),
        notExists(
          db
            .select({ id: pron.id })
            .from(pron)
            .where(and(eq(pron.lemmaId, knowledge.lemmaId), eq(pron.track, 'pronunciation'))),
        ),
      ),
    )
    .all()
  if (missing.length === 0) return
  const fields = initialKnowledgeFields(now)
  db.insert(knowledge)
    .values(
      missing.map(({ lemmaId }) => ({ lemmaId, track: 'pronunciation' as const, ...fields })),
    )
    .run()
}

/** Render a track's dues (weakest first) into items; unrenderable dues drop out. */
function renderDues(
  dues: DueLemma[],
  render: (d: DueLemma) => StoredItem | null,
): StoredItem[] {
  return dues.map(render).filter((i): i is StoredItem => i !== null)
}

/**
 * Build a Practice session (#10): due lemmas rendered through the applicable
 * exercise, held server-side under a fresh id. Mix (CONTEXT.md "Practice"):
 * one queue per active track — productive → spoken recall, receptive → MCQ,
 * pronunciation → read-aloud — drawn round-robin, so tracks get equal shares,
 * an empty queue yields its turn, and items come interleaved. A lemma appears
 * once per session (a read-aloud would give away a later spoken recall).
 * Mic off: receptive only.
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
  }: {
    limit?: number
    newCardLimit?: number
    mic?: boolean
  } = {},
): ClientSession {
  const pool = glossedCandidates(db)
  const byId = new Map(pool.map((c) => [c.lemmaId, c]))
  const due = (track: 'receptive' | 'productive' | 'pronunciation') =>
    dueLemmas(db, track, { limit, newCardLimit })

  const queues: StoredItem[][] = []
  if (mic) {
    seedProductiveCards(db)
    queues.push(
      renderDues(due('productive'), (d) => {
        const target = byId.get(d.lemmaId)
        if (!target || !spokenRecall.appliesTo(target)) return null
        const item = spokenRecall.generate(target, pool)
        return item && { exercise: 'spoken-recall', item }
      }),
    )
  }
  queues.push(
    renderDues(due('receptive'), (d) => {
      const target = byId.get(d.lemmaId)
      if (!target) return null // no cached gloss -> skip, never generate
      const item = recognitionMcq.generate(target, pool)
      return item && { exercise: 'recognition-mcq', item }
    }),
  )
  if (mic) {
    seedPronunciationCards(db)
    const usedSentences = new Set<string>()
    queues.push(
      renderDues(due('pronunciation'), (d) => {
        // read-aloud needs no gloss: build the candidate from the due row
        const sentence = sentenceFor(db, d.lemmaId, usedSentences)
        const target = { lemmaId: d.lemmaId, lemma: d.lemma, pos: d.pos, sentence }
        if (!readAloud.appliesTo(target)) return null
        usedSentences.add(sentence as string)
        const item = readAloud.generate(target, pool)
        return item && { exercise: 'read-aloud', item }
      }),
    )
  }

  // Round-robin: each turn every queue gives its next not-yet-used lemma.
  const items: StoredItem[] = []
  const used = new Set<number>()
  const cursors = queues.map(() => 0)
  for (let took = true; took && items.length < limit; ) {
    took = false
    queues.forEach((q, t) => {
      while (cursors[t] < q.length && used.has(q[cursors[t]].item.lemmaId)) cursors[t]++
      const next = q[cursors[t]]
      if (!next || items.length >= limit) return
      cursors[t]++
      used.add(next.item.lemmaId)
      items.push(next)
      took = true
    })
  }

  const id = crypto.randomUUID()
  sessions.set(id, { id, items, answered: new Map(), attempts: new Map() })
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

/** Shown after a Pronunciation grade: how hard the word is to say, when it's back. */
export interface PronunciationHint {
  lemma: string
  difficulty: number // FSRS difficulty, 1..10
  due: Date
}

export interface SpeechAnswerResult {
  /**
   * correct — item done. miss — not heard; answer revealed, retry or
   * self-grade. heard — spoken recall retry after the reveal was heard; the
   * pre-reveal attempt still needs its self-grade.
   */
  status: 'correct' | 'miss' | 'heard' | 'alreadyAnswered'
  transcript: string
  /** The target: on miss so the learner can self-grade, on hit for listen-back. */
  answer?: string
  hint?: PronunciationHint
}

function asSpeechItem(stored: StoredItem): SpeechStored {
  if (!(stored.exercise in speechExercises)) throw new Error('not a speech item')
  return stored as SpeechStored
}

function attemptsFor(s: StoredSession, itemId: string): SpeechAttempts {
  let a = s.attempts.get(itemId)
  if (!a) {
    a = { revealed: false, misses: 0, hit: false }
    s.attempts.set(itemId, a)
  }
  return a
}

/**
 * Visible attempts → Pronunciation rating (ADR-0005): clean first hit Good,
 * hit after misses Hard, misses only Again, no visible attempt → no write.
 * Easy never: one clean take doesn't make a word easy to say.
 */
export function pronunciationRating(a: Pick<SpeechAttempts, 'misses' | 'hit'>): Grade | null {
  if (a.hit) return a.misses === 0 ? Rating.Good : Rating.Hard
  return a.misses > 0 ? Rating.Again : null
}

function gradePronunciation(db: DB, item: SpeechStored['item'], rating: Grade): PronunciationHint {
  const next = gradeLemma(db, item.lemmaId, 'pronunciation', rating)
  return { lemma: item.lemma, difficulty: next.difficulty, due: next.due }
}

/**
 * Grade one spoken attempt. Spoken recall's first attempt is retrieval: a hit
 * grades productive Good and closes the item; a miss reveals the answer and
 * writes nothing (whisper misfires on short non-native words — the learner
 * self-grades instead). Every later attempt, and every read-aloud attempt, is
 * a visible attempt: misses are counted, a read-aloud hit closes the item with
 * its Pronunciation grade, a recall retry hit waits for the self-grade.
 */
export async function answerSpeechItem(
  db: DB,
  sessionId: string,
  itemId: string,
  audio: Blob,
): Promise<SpeechAnswerResult> {
  const { s, stored } = heldItem(sessionId, itemId)
  const speech = asSpeechItem(stored)
  if (s.answered.has(itemId)) return { status: 'alreadyAnswered', transcript: '' }
  const a = attemptsFor(s, itemId)
  const answer = speech.item.lemma
  const isRecall = speech.exercise === 'spoken-recall'
  if (a.hit) return { status: 'heard', transcript: '', answer } // already heard, awaiting self-grade

  const text = (await transcribe(audio)).trim()
  const response: SpokenResponse = {
    transcriptText: text,
    transcriptLemmas: text ? await transcriptLemmas(text) : [],
  }
  const hit =
    (isRecall
      ? spokenRecall.grade(speech.item, response)
      : readAloud.grade(speech.item, response)) === Rating.Good

  if (isRecall && !a.revealed) {
    if (hit) {
      gradeLemma(db, speech.item.lemmaId, 'productive', Rating.Good)
      s.answered.set(itemId, true)
      return { status: 'correct', transcript: text, answer }
    }
    a.revealed = true
    return { status: 'miss', transcript: text, answer }
  }

  if (!hit) {
    a.misses++
    return { status: 'miss', transcript: text, answer }
  }
  a.hit = true
  if (isRecall) return { status: 'heard', transcript: text, answer }
  const hint = gradePronunciation(db, speech.item, pronunciationRating(a) as Grade)
  s.answered.set(itemId, true)
  return { status: 'correct', transcript: text, answer, hint }
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
 * The learner then self-grades, same as after an ASR miss; spoken-recall
 * attempts from here on are visible attempts.
 */
export function revealItem(sessionId: string, itemId: string): { answer: string } {
  const { s, stored } = heldItem(sessionId, itemId)
  attemptsFor(s, itemId).revealed = true
  return { answer: asSpeechItem(stored).item.lemma }
}

/**
 * Self-grade after a reveal ("said it" / "didn't"), exactly once, closing the
 * item. Spoken recall: the verdict is about the pre-reveal attempt →
 * productive; retries after the reveal, if any, → pronunciation. Read-aloud:
 * the verdict is about saying it → pronunciation ("said it" is Hard: an ASR
 * miss can't tell mishearing from mispronouncing).
 */
export function selfGradeItem(
  db: DB,
  sessionId: string,
  itemId: string,
  saidIt: boolean,
): { alreadyAnswered: boolean; hint?: PronunciationHint } {
  const { s, stored } = heldItem(sessionId, itemId)
  const speech = asSpeechItem(stored)
  if (s.answered.has(itemId)) return { alreadyAnswered: true }
  const a = attemptsFor(s, itemId)

  let hint: PronunciationHint | undefined
  if (speech.exercise === 'read-aloud') {
    hint = gradePronunciation(db, speech.item, saidIt ? Rating.Hard : Rating.Again)
  } else {
    gradeLemma(db, speech.item.lemmaId, 'productive', saidIt ? Rating.Good : Rating.Again)
    const rating = pronunciationRating(a)
    if (rating !== null) hint = gradePronunciation(db, speech.item, rating)
  }
  s.answered.set(itemId, saidIt)
  return { alreadyAnswered: false, hint }
}

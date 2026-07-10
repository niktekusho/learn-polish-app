import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '#/db/schema'
import { gloss, lemma } from '#/db/schema'
import type {
  McqClientItem,
  McqItem,
} from '#/exercises/recognition-mcq'
import { recognitionMcq } from '#/exercises/recognition-mcq'
import type { ExerciseCandidate } from '#/exercises/types'
import { dueLemmas, gradeLemma } from '#/fsrs/index'

type DB = BetterSQLite3Database<typeof schema>

interface StoredSession {
  id: string
  items: McqItem[] // full items, held server-side (carry the answer)
  answered: Map<string, boolean> // itemId -> was correct
}

// ponytail: in-memory, single-user. A reload resumes via the session id; a
// server restart drops sessions and the client just starts a fresh one. Move to
// a table only if persistent/multi-device resume is ever needed.
const sessions = new Map<string, StoredSession>()

export interface ClientSession {
  sessionId: string
  items: McqClientItem[] // answer-free projection
  answered: { itemId: string; correct: boolean }[]
}

/** Glossed lemmas only — the MCQ target + distractor source. */
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
 * Build a Practice session (#10): due lemmas (reviews first, capped New — #8)
 * rendered through recognition-MCQ, held server-side under a fresh id.
 *
 * NO gloss generation here: Practice has no sentence context (#6), so lemmas
 * without a cached gloss are simply skipped. Zero provider/LLM calls.
 */
export function buildSession(
  db: DB,
  { limit = 20, newCardLimit }: { limit?: number; newCardLimit?: number } = {},
): ClientSession {
  const due = dueLemmas(db, 'receptive', { limit, newCardLimit })
  const pool = glossedCandidates(db)
  const byId = new Map(pool.map((c) => [c.lemmaId, c]))

  const items: McqItem[] = []
  for (const d of due) {
    const target = byId.get(d.lemmaId)
    if (!target) continue // no cached gloss -> skip, never generate
    const item = recognitionMcq.generate(target, pool)
    if (item) items.push(item)
  }

  const id = crypto.randomUUID()
  sessions.set(id, { id, items, answered: new Map() })
  return { sessionId: id, items: items.map(recognitionMcq.toClient), answered: [] }
}

/** Re-project a held session (reload/refocus resume). null if unknown/expired. */
export function resumeSession(sessionId: string): ClientSession | null {
  const s = sessions.get(sessionId)
  if (!s) return null
  return {
    sessionId,
    items: s.items.map(recognitionMcq.toClient),
    answered: [...s.answered].map(([itemId, correct]) => ({ itemId, correct })),
  }
}

export interface AnswerResult {
  correct: boolean
  correctIndex: number
  alreadyAnswered: boolean // true = this item was already graded; FSRS untouched
}

/**
 * Grade one answer against the server-held item, exactly once. A repeat submit
 * for the same item is rejected (no second FSRS update) so a double-click or
 * replayed request can't advance scheduling twice.
 */
export function answerItem(
  db: DB,
  sessionId: string,
  itemId: string,
  choiceIndex: number,
): AnswerResult {
  const s = sessions.get(sessionId)
  if (!s) throw new Error('practice session not found')
  const item = s.items.find((i) => i.id === itemId)
  if (!item) throw new Error('item not in session')

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

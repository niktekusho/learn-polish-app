import { and, asc, eq, lte, ne } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import {
  type Card,
  type Grade,
  type State,
  createEmptyCard,
  fsrs,
  generatorParameters,
} from 'ts-fsrs'
import * as schema from '#/db/schema'
import { knowledge, lemma, reviewLog } from '#/db/schema'

export { Rating } from 'ts-fsrs'
export type { Grade } from 'ts-fsrs'

export type Track = 'receptive' | 'productive'
type DB = BetterSQLite3Database<typeof schema>
type KnowledgeRow = typeof knowledge.$inferSelect
/** The FSRS columns of a knowledge row — enough to build a ts-fsrs Card. */
type CardFields = Pick<
  KnowledgeRow,
  | 'stability'
  | 'difficulty'
  | 'due'
  | 'lastReview'
  | 'state'
  | 'reps'
  | 'lapses'
  | 'elapsedDays'
  | 'scheduledDays'
  | 'learningSteps'
>

// FSRS State enum values we branch on.
const STATE_NEW = 0

// Default cap on brand-new cards introduced per session (see dueLemmas).
export const DEFAULT_NEW_CARD_LIMIT = 10

// One scheduler for the app. ADR-0003: FSRS drives selection + scheduling.
const scheduler = fsrs(generatorParameters())

function rowToCard(k: CardFields): Card {
  return {
    due: k.due,
    stability: k.stability,
    difficulty: k.difficulty,
    elapsed_days: k.elapsedDays,
    scheduled_days: k.scheduledDays,
    reps: k.reps,
    lapses: k.lapses,
    learning_steps: k.learningSteps,
    state: k.state as State,
    last_review: k.lastReview ?? undefined,
  }
}

function cardToRow(c: Card): CardFields {
  return {
    stability: c.stability,
    difficulty: c.difficulty,
    due: c.due,
    lastReview: c.last_review ?? null,
    state: c.state,
    reps: c.reps,
    lapses: c.lapses,
    elapsedDays: c.elapsed_days,
    scheduledDays: c.scheduled_days,
    learningSteps: c.learning_steps,
  }
}

/** FSRS column defaults for a brand-new ("unknown") knowledge row. #4 uses this. */
export function initialKnowledgeFields(now = new Date()): CardFields {
  return cardToRow(createEmptyCard(now))
}

/** Pure: given a track state + rating, return the next FSRS column values. */
export function schedule(
  state: CardFields,
  rating: Grade,
  now = new Date(),
): CardFields {
  const { card } = scheduler.next(rowToCard(state), now, rating)
  return cardToRow(card)
}

/**
 * Grade a lemma's track, persist the new FSRS state, and append a review_log
 * row — all in one transaction (#8). The shared helper #7 (mark known) and #10
 * (practice) both call. Creates the knowledge row if missing.
 */
export function gradeLemma(
  db: DB,
  lemmaId: number,
  track: Track,
  rating: Grade,
  now = new Date(),
): CardFields {
  return db.transaction((tx) => {
    const [existing] = tx
      .select()
      .from(knowledge)
      .where(and(eq(knowledge.lemmaId, lemmaId), eq(knowledge.track, track)))
      .all()

    const base: CardFields = existing ?? initialKnowledgeFields(now)
    const stateBefore = base.state
    const next = schedule(base, rating, now)

    if (existing) {
      tx.update(knowledge).set(next).where(eq(knowledge.id, existing.id)).run()
    } else {
      tx.insert(knowledge).values({ lemmaId, track, ...next }).run()
    }

    tx.insert(reviewLog)
      .values({
        lemmaId,
        track,
        rating,
        stateBefore,
        stateAfter: next.state,
        reviewedAt: now,
      })
      .run()

    return next
  })
}

export interface DueLemma {
  lemmaId: number
  lemma: string
  pos: string
  track: Track
  due: Date
  stability: number
  state: number
}

/**
 * Due lemmas for a track, with New-card introduction gated. Import makes every
 * lemma due immediately with stability 0, so a naive weakest-first order lets
 * one pasted article bury genuine reviews forever. Rule (#8): actual reviews
 * (state != New) come first, weakest first; then at most `newCardLimit` New
 * cards, within the overall `limit` budget.
 */
export function dueLemmas(
  db: DB,
  track: Track,
  {
    now = new Date(),
    limit = 50,
    newCardLimit = DEFAULT_NEW_CARD_LIMIT,
  }: { now?: Date; limit?: number; newCardLimit?: number } = {},
): DueLemma[] {
  const cols = {
    lemmaId: lemma.id,
    lemma: lemma.lemma,
    pos: lemma.pos,
    track: knowledge.track,
    due: knowledge.due,
    stability: knowledge.stability,
    state: knowledge.state,
  }

  const reviews = db
    .select(cols)
    .from(knowledge)
    .innerJoin(lemma, eq(knowledge.lemmaId, lemma.id))
    .where(
      and(
        eq(knowledge.track, track),
        lte(knowledge.due, now),
        ne(knowledge.state, STATE_NEW),
      ),
    )
    .orderBy(asc(knowledge.stability), asc(knowledge.due))
    .limit(limit)
    .all()

  const newBudget = Math.min(newCardLimit, Math.max(0, limit - reviews.length))
  const news = newBudget
    ? db
        .select(cols)
        .from(knowledge)
        .innerJoin(lemma, eq(knowledge.lemmaId, lemma.id))
        .where(
          and(
            eq(knowledge.track, track),
            lte(knowledge.due, now),
            eq(knowledge.state, STATE_NEW),
          ),
        )
        .orderBy(asc(knowledge.due))
        .limit(newBudget)
        .all()
    : []

  return [...reviews, ...news] as DueLemma[]
}

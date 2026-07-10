import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '#/db/schema'
import { knowledge, token } from '#/db/schema'
import { Rating, gradeLemma } from '#/fsrs/index'

type DB = BetterSQLite3Database<typeof schema>

const STATE_NEW = 0

/**
 * Batch-mark every still-New word in a text as known (grade Easy), in ONE
 * transaction (#7). Excludes words the user explicitly marked "still learning"
 * (Learning/Relearning) — those are never New, so filtering on state = New is
 * exactly the "don't overwrite an explicit judgment" rule. Returns the affected
 * lemma ids.
 */
export function markNewKnown(db: DB, textId: number): number[] {
  const eligible = db
    .select({ lemmaId: knowledge.lemmaId })
    .from(token)
    .innerJoin(
      knowledge,
      and(
        eq(knowledge.lemmaId, token.lemmaId),
        eq(knowledge.track, 'receptive'),
      ),
    )
    .where(and(eq(token.textId, textId), eq(knowledge.state, STATE_NEW)))
    .groupBy(knowledge.lemmaId)
    .all()
    .map((r) => r.lemmaId)

  db.transaction((tx) => {
    for (const lemmaId of eligible) {
      gradeLemma(tx, lemmaId, 'receptive', Rating.Easy)
    }
  })
  return eligible
}

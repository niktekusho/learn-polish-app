import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '#/db/schema'
import { gloss } from '#/db/schema'
import { type GlossProvider, getGlossProvider } from '#/llm/provider'

type DB = BetterSQLite3Database<typeof schema>

export interface GlossResult {
  italian: string | null // null = not cached and no context to generate from
  cached: boolean // true = served from cache (no provider call)
}

export interface GlossInput {
  lemmaId: number
  lemma: string
  pos: string
  sentence: string
}

/**
 * Italian gloss for a lemma, cached in the `gloss` table.
 *
 * Sentence context is MANDATORY to generate (#6): a context-free gloss written
 * to the cache would become *the* gloss for that lemma forever, defeating the
 * disambiguation design. So a caller with no sentence (e.g. Practice) reads the
 * cache only — a miss returns { italian: null } and writes nothing. The cache
 * row records which provider produced it, so stub output can be purged later.
 */
export async function getGloss(
  db: DB,
  input: GlossInput,
  provider: GlossProvider = getGlossProvider(),
): Promise<GlossResult> {
  const [existing] = db
    .select()
    .from(gloss)
    .where(and(eq(gloss.lemmaId, input.lemmaId), eq(gloss.sense, '')))
    .all()
  if (existing) return { italian: existing.italian, cached: true }

  const sentence = input.sentence.trim()
  if (!sentence) return { italian: null, cached: false } // read-only, no context

  const italian = await provider.gloss({
    lemma: input.lemma,
    pos: input.pos,
    sentence,
  })
  db.insert(gloss)
    .values({
      lemmaId: input.lemmaId,
      sense: '',
      italian,
      provider: provider.name,
    })
    .onConflictDoNothing()
    .run()

  // Re-read so a racing insert's value wins deterministically.
  const [row] = db
    .select()
    .from(gloss)
    .where(and(eq(gloss.lemmaId, input.lemmaId), eq(gloss.sense, '')))
    .all()
  return { italian: row.italian, cached: false }
}

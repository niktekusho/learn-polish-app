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

  let italian: string
  try {
    italian = await provider.gloss({
      lemma: input.lemma,
      pos: input.pos,
      sentence,
    })
  } catch (err) {
    // Log server-side (the pnpm dev terminal) — the error otherwise only
    // surfaces as the panel's generic "failed" state, hiding the real cause
    // (e.g. `claude exited 1: 401 Invalid authentication credentials`).
    console.error(
      `[gloss] provider "${provider.name}" failed for lemma "${input.lemma}" (id ${input.lemmaId}):`,
      err,
    )
    throw err
  }
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

/**
 * Overwrite the default-sense gloss for a lemma with a learner-written value.
 * Recorded as provider 'manual' — the highest-trust tier, which purge and
 * regenerate never touch. Trims and rejects empty input.
 */
export function setManualGloss(db: DB, lemmaId: number, italian: string): string {
  const value = italian.trim()
  if (!value) throw new Error('manual gloss cannot be empty')
  db.insert(gloss)
    .values({ lemmaId, sense: '', italian: value, provider: 'manual' })
    .onConflictDoUpdate({
      target: [gloss.lemmaId, gloss.sense],
      set: { italian: value, provider: 'manual' },
    })
    .run()
  return value
}

/**
 * Discard the cached default-sense gloss and generate a fresh one from context.
 * The explicit user "regenerate" action — so it overwrites even a manual gloss.
 */
export async function regenerateGloss(
  db: DB,
  input: GlossInput,
  provider: GlossProvider = getGlossProvider(),
): Promise<GlossResult> {
  db.delete(gloss)
    .where(and(eq(gloss.lemmaId, input.lemmaId), eq(gloss.sense, '')))
    .run()
  return getGloss(db, input, provider)
}

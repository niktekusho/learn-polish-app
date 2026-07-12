import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '#/db/schema'
import { gloss } from '#/db/schema'
import { lookupDictionary, senseKey } from '#/dictionary/service'
import { type GlossProvider, getGlossProvider } from '#/llm/provider'

type DB = BetterSQLite3Database<typeof schema>

// Cap on how many Wiktionary senses one LLM call translates. Pathological
// entries (być, mieć) have dozens; senses beyond the cap get an Italian
// gloss only via a later regenerate.
const MAX_SENSES = 12

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
 *
 * Display invariant: the inline reader gloss is ALWAYS the sense='' row.
 * When the lemma is in the home dictionary and the provider supports it, the
 * hybrid path (ADR-0002) fills the cache in one call: every Wiktionary sense
 * gets a per-sense row (sense = senseKey(english)), and the sense the LLM
 * flags as fitting the sentence is copied into sense=''. Out-of-dictionary
 * lemmas keep the sentence-context path below (sense='').
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

  if (provider.glossSenses) {
    const dict = lookupDictionary(db, input.lemma, input.pos)
    const senses = dict.entries.flatMap((e) => e.senses).slice(0, MAX_SENSES)
    if (senses.length > 0) {
      return glossFromSenses(db, { ...input, sentence }, senses, provider)
    }
  }

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
 * Hybrid per-sense glossing: ONE provider call translates all senses AND
 * flags the one fitting the sentence. All writes land in one transaction so
 * a junk response caches nothing. onConflictDoNothing everywhere: existing
 * rows (manual per-sense edits, racing inserts) always win.
 */
async function glossFromSenses(
  db: DB,
  input: GlossInput,
  senses: { gloss: string }[],
  provider: GlossProvider,
): Promise<GlossResult> {
  let result: Awaited<ReturnType<NonNullable<GlossProvider['glossSenses']>>>
  try {
    result = await provider.glossSenses!({
      lemma: input.lemma,
      pos: input.pos,
      sentence: input.sentence,
      senses: senses.map((s, index) => ({ index, gloss: s.gloss })),
    })
  } catch (err) {
    console.error(
      `[gloss] provider "${provider.name}" failed sense-glossing lemma "${input.lemma}" (id ${input.lemmaId}):`,
      err,
    )
    throw err
  }

  const best = result.translations.find((t) => t.index === result.bestIndex)!
  db.transaction((tx) => {
    for (const t of result.translations) {
      tx.insert(gloss)
        .values({
          lemmaId: input.lemmaId,
          sense: senseKey(senses[t.index].gloss),
          italian: t.italian,
          provider: provider.name,
        })
        .onConflictDoNothing()
        .run()
    }
    tx.insert(gloss)
      .values({
        lemmaId: input.lemmaId,
        sense: '',
        italian: best.italian,
        provider: provider.name,
      })
      .onConflictDoNothing()
      .run()
  })

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
 * Discard ALL cached glosses for the lemma (default-sense and per-sense) and
 * generate fresh. The explicit user "regenerate" action — so it overwrites
 * even manual glosses, consistent with the pre-kaikki semantics.
 */
export async function regenerateGloss(
  db: DB,
  input: GlossInput,
  provider: GlossProvider = getGlossProvider(),
): Promise<GlossResult> {
  db.delete(gloss).where(eq(gloss.lemmaId, input.lemmaId)).run()
  return getGloss(db, input, provider)
}

import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '#/db/schema'
import { knowledge, lemma, mweOccurrence, sourceText, token } from '#/db/schema'
import { detectMwes, loadMweHeadwords, type MweToken } from '#/dictionary/mwe'
import { initialKnowledgeFields } from '#/fsrs/index'
import type { AnalyzeResponse, AnalyzedToken } from './sidecar'

type DB = BetterSQLite3Database<typeof schema>

// UPOS tags that are layout/noise, not vocabulary worth tracking.
const SKIP_POS = new Set(['PUNCT', 'SYM', 'SPACE', 'X'])
function isVocab(t: AnalyzedToken): boolean {
  return !t.is_space && !SKIP_POS.has(t.pos) && t.lemma.trim() !== ''
}

export interface ImportResult {
  textId: number
  tokenCount: number
  lemmaCount: number // distinct lemmas in this text
  mweCount: number // MWE occurrences detected in this text
}

/**
 * Persist an analyzed document: one `source_text`, its `token`s in reading
 * order, upserted `lemma`s, and a receptive `knowledge` row (default "new") per
 * newly-seen lemma. Idempotent on lemmas/knowledge: re-importing links to the
 * existing lemmas instead of duplicating them.
 *
 * ponytail: only the receptive track is seeded here — it's the only one the
 * MVP reads/exercises. gradeLemma() lazily creates the productive row if a
 * productive exercise ever grades the lemma.
 */
export function persistAnalysis(
  db: DB,
  input: { title?: string | null; content: string },
  analysis: AnalyzeResponse,
  now = new Date(),
  // Injectable so pipeline tests stay sidecar- and dictionary-free.
  mweHeadwords?: Map<string, string[]>,
): ImportResult {
  return db.transaction((tx) => {
    const [{ id: textId }] = tx
      .insert(sourceText)
      .values({ title: input.title ?? null, content: input.content })
      .returning({ id: sourceText.id })
      .all()

    const seen = new Set<number>()
    const collected: MweToken[] = []
    let position = 0
    for (let s = 0; s < analysis.sentences.length; s++) {
      for (const tok of analysis.sentences[s].tokens) {
        let lemmaId: number | null = null
        if (isVocab(tok)) {
          lemmaId = upsertLemma(tx, tok.lemma, tok.pos)
          if (!seen.has(lemmaId)) {
            seen.add(lemmaId)
            ensureReceptiveKnowledge(tx, lemmaId, now)
          }
        }
        tx.insert(token)
          .values({
            textId,
            lemmaId,
            surface: tok.surface,
            position,
            sentenceIndex: s,
            isSpace: tok.is_space,
          })
          .run()
        if (!tok.is_space) {
          collected.push({
            surface: tok.surface,
            lemma: lemmaId != null ? tok.lemma : null,
            position,
            sentenceIndex: s,
            isSpace: false,
          })
        }
        position++
      }
    }

    // Contiguous MWE detection against the home dictionary's multi-word
    // headwords. Each match becomes a pos='MWE' tracked unit + occurrence.
    const matches = detectMwes(collected, mweHeadwords ?? loadMweHeadwords(tx))
    for (const m of matches) {
      const mweLemmaId = upsertLemma(tx, m.headword, 'MWE')
      if (!seen.has(mweLemmaId)) {
        seen.add(mweLemmaId)
        ensureReceptiveKnowledge(tx, mweLemmaId, now)
      }
      tx.insert(mweOccurrence)
        .values({
          textId,
          lemmaId: mweLemmaId,
          startPosition: m.startPosition,
          endPosition: m.endPosition,
          sentenceIndex: m.sentenceIndex,
        })
        .run()
    }

    return {
      textId,
      tokenCount: position,
      lemmaCount: seen.size,
      mweCount: matches.length,
    }
  })
}

/** Insert-or-get a lemma by its (base form, POS) identity. */
function upsertLemma(db: DB, lemmaText: string, pos: string): number {
  db.insert(lemma).values({ lemma: lemmaText, pos }).onConflictDoNothing().run()
  const [row] = db
    .select({ id: lemma.id })
    .from(lemma)
    .where(and(eq(lemma.lemma, lemmaText), eq(lemma.pos, pos)))
    .all()
  return row.id
}

/** Create the receptive knowledge row if the lemma doesn't have one yet. */
function ensureReceptiveKnowledge(db: DB, lemmaId: number, now: Date): void {
  db.insert(knowledge)
    .values({ lemmaId, track: 'receptive', ...initialKnowledgeFields(now) })
    .onConflictDoNothing()
    .run()
}

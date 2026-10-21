import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "#/db/schema";
import { knowledge, lemma, mweOccurrence, sourceText, token } from "#/db/schema";
import { detectMwes, loadMweHeadwords, type MweToken } from "#/dictionary/mwe";
import { correctLemma } from "#/dictionary/lemma-correction";
import { initialKnowledgeFields } from "#/fsrs/index";
import { NAME_POS } from "#/reader/name";
import { classifyToken } from "./classify";
import type { AnalyzeResponse } from "./sidecar";

type DB = BetterSQLite3Database<typeof schema>;

export interface ImportResult {
  textId: number;
  tokenCount: number;
  lemmaCount: number; // distinct lemmas in this text
  mweCount: number; // MWE occurrences detected in this text
}

/**
 * Persist an analyzed document: one `source_text`, its `token`s in reading
 * order, upserted `lemma`s, and a receptive `knowledge` row (default "new") per
 * newly-seen lemma. A Name links to its lemma but gets no knowledge row
 * (see classifyToken). Idempotent on lemmas/knowledge: re-importing links to the
 * existing lemmas instead of duplicating them.
 *
 * ponytail: only the receptive track is seeded here — it's the only one the
 * MVP reads/exercises. gradeLemma() lazily creates the productive row if a
 * productive exercise ever grades the lemma.
 */
export function persistAnalysis(
  db: DB,
  input: { title?: string | null; content: string; storyId?: number; episodeNumber?: number },
  analysis: AnalyzeResponse,
  now = new Date(),
  // Injectable so pipeline tests stay sidecar- and dictionary-free.
  mweHeadwords?: Map<string, string[]>,
): ImportResult {
  return db.transaction((tx) => {
    const [{ id: textId }] = tx
      .insert(sourceText)
      .values({
        title: input.title ?? null,
        content: input.content,
        storyId: input.storyId,
        episodeNumber: input.episodeNumber,
      })
      .returning({ id: sourceText.id })
      .all();

    const seen = new Set<number>();
    const collected: MweToken[] = [];
    let position = 0;
    for (let s = 0; s < analysis.sentences.length; s++) {
      for (const tok of analysis.sentences[s].tokens) {
        let lemmaId: number | null = null;
        let lemmaText: string | null = null;
        const classified = classifyToken(tx, tok);
        if (classified.kind === "name") {
          lemmaText = classified.lemma;
          lemmaId = upsertLemma(tx, lemmaText, NAME_POS);
        } else if (classified.kind === "unit") {
          lemmaText = correctLemma(tx, tok.surface, classified.lemma, classified.pos);
          lemmaId = upsertLemma(tx, lemmaText, classified.pos);
          if (!seen.has(lemmaId)) {
            seen.add(lemmaId);
            ensureReceptiveKnowledge(tx, lemmaId, now);
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
            tags: tok.tags,
          })
          .run();
        if (!tok.is_space) {
          collected.push({
            surface: tok.surface,
            lemma: lemmaText,
            position,
            sentenceIndex: s,
            isSpace: false,
          });
        }
        position++;
      }
    }

    // Contiguous MWE detection against the home dictionary's multi-word
    // headwords. Each match becomes a pos='MWE' tracked unit + occurrence.
    const matches = detectMwes(collected, mweHeadwords ?? loadMweHeadwords(tx));
    for (const m of matches) {
      const mweLemmaId = upsertLemma(tx, m.headword, "MWE");
      if (!seen.has(mweLemmaId)) {
        seen.add(mweLemmaId);
        ensureReceptiveKnowledge(tx, mweLemmaId, now);
      }
      tx.insert(mweOccurrence)
        .values({
          textId,
          lemmaId: mweLemmaId,
          startPosition: m.startPosition,
          endPosition: m.endPosition,
          sentenceIndex: m.sentenceIndex,
        })
        .run();
    }

    return {
      textId,
      tokenCount: position,
      lemmaCount: seen.size,
      mweCount: matches.length,
    };
  });
}

/** Insert-or-get a lemma by its (base form, POS) identity. */
export function upsertLemma(db: DB, lemmaText: string, pos: string): number {
  db.insert(lemma).values({ lemma: lemmaText, pos }).onConflictDoNothing().run();
  const [row] = db
    .select({ id: lemma.id })
    .from(lemma)
    .where(and(eq(lemma.lemma, lemmaText), eq(lemma.pos, pos)))
    .all();
  return row.id;
}

/** Create the receptive knowledge row if the lemma doesn't have one yet. */
export function ensureReceptiveKnowledge(db: DB, lemmaId: number, now: Date): void {
  db.insert(knowledge)
    .values({ lemmaId, track: "receptive", ...initialKnowledgeFields(now) })
    .onConflictDoNothing()
    .run();
}

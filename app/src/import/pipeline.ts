import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "#/db/schema";
import { knowledge, lemma, mweOccurrence, passageQuestion, sourceText, token } from "#/db/schema";
import { detectMwes, loadMweHeadwords, type MweMatch, type MweToken } from "#/dictionary/mwe";
import { correctLemma } from "#/dictionary/lemma-correction";
import { initialKnowledgeFields } from "#/fsrs/index";
import { NAME_POS } from "#/reader/name";
import { classifyToken, FORMULA_POS } from "./classify";
import type { AnalyzeResponse } from "./sidecar";

type DB = BetterSQLite3Database<typeof schema>;

export interface ImportResult {
  textId: number;
  tokenCount: number;
  lemmaCount: number; // distinct lemmas in this text
  mweCount: number; // MWE occurrences detected in this text
}

interface TextInput {
  title?: string | null;
  content: string;
  storyId?: number;
  episodeNumber?: number;
}

/**
 * Persist an analyzed document: one `source_text`, its `token`s in reading
 * order, upserted `lemma`s, and a receptive `knowledge` row (default "new") per
 * newly-seen lemma. A Name links to its lemma but gets no knowledge row
 * (see classifyToken). Idempotent on lemmas/knowledge: re-importing links to the
 * existing lemmas instead of duplicating them. With `textId`, the stored text
 * keeps its row and gets the new content, tokens and MWE occurrences; its
 * passage questions go, to be cut again from the new content.
 *
 * ponytail: only the receptive track is seeded here — it's the only one the
 * MVP reads/exercises. gradeLemma() lazily creates the productive row if a
 * productive exercise ever grades the lemma.
 */
export function persistAnalysis(
  db: DB,
  input: TextInput & { textId?: number },
  analysis: AnalyzeResponse,
  now = new Date(),
  // Injectable so pipeline tests stay sidecar- and dictionary-free.
  mweHeadwords?: Map<string, string[]>,
  // Accepted Formula positions from resolveFormulas, with their headword.
  formulas = new Map<number, string>(),
  // The MWE matches to save; importAnalysis passes only the ones its check accepted.
  mwes = analysisMwes(db, analysis, formulas, mweHeadwords),
): ImportResult {
  return db.transaction((tx) => {
    const textId = input.textId ?? insertText(tx, input);
    if (input.textId !== undefined) {
      tx.update(sourceText).set({ content: input.content }).where(eq(sourceText.id, textId)).run();
      tx.delete(token).where(eq(token.textId, textId)).run();
      tx.delete(mweOccurrence).where(eq(mweOccurrence.textId, textId)).run();
      tx.delete(passageQuestion).where(eq(passageQuestion.textId, textId)).run();
    }

    const seen = new Set<number>();
    let position = 0;
    for (let s = 0; s < analysis.sentences.length; s++) {
      for (const tok of analysis.sentences[s].tokens) {
        const assigned = tokenLemma(tx, tok, formulas.get(position));
        const lemmaId = assigned && upsertLemma(tx, assigned.lemma, assigned.pos);
        if (lemmaId !== null && assigned?.pos !== NAME_POS && !seen.has(lemmaId)) {
          seen.add(lemmaId);
          ensureReceptiveKnowledge(tx, lemmaId, now);
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
        position++;
      }
    }

    for (const m of mwes) {
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
      mweCount: mwes.length,
    };
  });
}

function insertText(db: DB, input: TextInput): number {
  return db
    .insert(sourceText)
    .values({
      title: input.title ?? null,
      content: input.content,
      storyId: input.storyId,
      episodeNumber: input.episodeNumber,
    })
    .returning({ id: sourceText.id })
    .all()[0].id;
}

/** The lemma and POS a token is saved under, or null when it is no word. */
function tokenLemma(
  db: DB,
  tok: AnalyzeResponse["sentences"][number]["tokens"][number],
  formula: string | undefined,
): { lemma: string; pos: string } | null {
  const classified = classifyToken(db, tok);
  if (classified.kind === "name") return { lemma: classified.lemma, pos: NAME_POS };
  if (classified.kind === "skip") return null;
  if (formula) return { lemma: formula, pos: FORMULA_POS };
  return correctLemma(db, tok.surface, classified.lemma, classified.pos);
}

/**
 * Contiguous MWE matches in an analysis against the home dictionary's
 * multi-word headwords, with token lemmas as persistAnalysis saves them.
 */
export function analysisMwes(
  db: DB,
  analysis: AnalyzeResponse,
  formulas = new Map<number, string>(),
  mweHeadwords?: Map<string, string[]>,
): MweMatch[] {
  const tokens: MweToken[] = [];
  let position = 0;
  analysis.sentences.forEach((s, sentenceIndex) => {
    for (const tok of s.tokens) {
      if (!tok.is_space) {
        const lemma = tokenLemma(db, tok, formulas.get(position))?.lemma ?? null;
        tokens.push({ surface: tok.surface, lemma, position, sentenceIndex, isSpace: false });
      }
      position++;
    }
  });
  return detectMwes(tokens, mweHeadwords ?? loadMweHeadwords(db));
}

/** A sentence's text as its tokens spell it. */
export function analysisSentence(s: AnalyzeResponse["sentences"][number]): string {
  return s.tokens
    .map((t) => t.surface)
    .join("")
    .trim();
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

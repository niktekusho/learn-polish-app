import { and, eq, inArray, notExists, notInArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "#/db/schema";
import { dictEntry, lemma, token } from "#/db/schema";
import { classifyToken, FORMULA_POS } from "#/import/classify";
import { analysisSentence, ensureReceptiveKnowledge, upsertLemma } from "#/import/pipeline";
import type { AnalyzeResponse } from "#/import/sidecar";
import { NAME_POS } from "#/reader/name";
import { correctLemma } from "./lemma-correction";
import { checkInContext, type MweChecker, sentenceText } from "./mwe-check";

type DB = BetterSQLite3Database<typeof schema>;

/**
 * The interjection headword a token may stand for (CONTEXT.md "Formula"), or
 * null when its surface is no interjection or the analyzer already gave it
 * that lemma (tak, dzięki).
 */
export function formulaHeadword(db: DB, surface: string, tokenLemma: string): string | null {
  const word = surface.trim().toLowerCase();
  if (word === tokenLemma.toLowerCase()) return null;
  const [row] = db
    .select({ id: dictEntry.id })
    .from(dictEntry)
    .where(and(eq(dictEntry.word, word), eq(dictEntry.pos, "intj")))
    .limit(1)
    .all();
  return row ? word : null;
}

/**
 * Formula candidates in an analysis, checked in their sentences. Returns the
 * accepted token positions (as persistAnalysis counts them) with their
 * headword. Throws when the check cannot run: nothing has been saved yet.
 */
export async function resolveFormulas(
  db: DB,
  checker: MweChecker,
  analysis: AnalyzeResponse,
): Promise<Map<number, string>> {
  const candidates: { position: number; headword: string; sentence: string }[] = [];
  let position = 0;
  for (const s of analysis.sentences) {
    const sentence = analysisSentence(s);
    for (const tok of s.tokens) {
      const classified = classifyToken(db, tok);
      if (classified.kind === "unit") {
        const corrected = correctLemma(db, tok.surface, classified.lemma, classified.pos);
        const headword = formulaHeadword(db, tok.surface, corrected);
        if (headword) candidates.push({ position, headword, sentence });
      }
      position++;
    }
  }
  const accepted = await checkInContext(db, checker, "Formula", candidates);
  return new Map(candidates.filter((_, i) => accepted[i]).map((c) => [c.position, c.headword]));
}

export interface FormulaRepair {
  moved: number; // tokens relinked to their formula
  deletedLemmas: number; // lemmas left without tokens, deleted with their data
}

/**
 * Formula detection over stored texts. Accepted tokens move to the formula
 * unit, which starts with fresh knowledge; a lemma left without tokens is
 * deleted, and its knowledge, history and glosses cascade.
 */
export async function repairFormulas(db: DB, checker: MweChecker): Promise<FormulaRepair> {
  const rows = db
    .select({
      id: token.id,
      textId: token.textId,
      sentenceIndex: token.sentenceIndex,
      surface: token.surface,
      lemmaId: lemma.id,
      lemma: lemma.lemma,
    })
    .from(token)
    .innerJoin(lemma, eq(token.lemmaId, lemma.id))
    .where(notInArray(lemma.pos, [NAME_POS, "MWE"]))
    .all();
  const candidates = rows.flatMap((r) => {
    const headword = formulaHeadword(db, r.surface, r.lemma);
    return headword
      ? [{ ...r, headword, sentence: sentenceText(db, r.textId, r.sentenceIndex) }]
      : [];
  });
  const accepted = await checkInContext(db, checker, "Formula", candidates);
  const moves = candidates.filter((_, i) => accepted[i]);
  if (moves.length === 0) return { moved: 0, deletedLemmas: 0 };

  return db.transaction((tx) => {
    const now = new Date();
    for (const m of moves) {
      const formulaId = upsertLemma(tx, m.headword, FORMULA_POS);
      ensureReceptiveKnowledge(tx, formulaId, now);
      tx.update(token).set({ lemmaId: formulaId }).where(eq(token.id, m.id)).run();
    }
    const { changes } = tx
      .delete(lemma)
      .where(
        and(
          inArray(lemma.id, [...new Set(moves.map((m) => m.lemmaId))]),
          notExists(tx.select().from(token).where(eq(token.lemmaId, lemma.id))),
        ),
      )
      .run();
    return { moved: moves.length, deletedLemmas: changes };
  });
}

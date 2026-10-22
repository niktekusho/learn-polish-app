import { and, eq, inArray, notExists, notInArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "#/db/schema";
import { dictEntry, gloss, lemma, occurrenceGloss, token } from "#/db/schema";
import { classifyToken, FORMULA_POS } from "#/import/classify";
import { analysisSentence, ensureReceptiveKnowledge, upsertLemma } from "#/import/pipeline";
import type { AnalyzeResponse } from "#/import/sidecar";
import { NAME_POS } from "#/reader/name";
import { correctLemma } from "./lemma-correction";
import { checkInContext, forgetUnit, type MweChecker, sentenceText } from "./mwe-check";

type DB = BetterSQLite3Database<typeof schema>;

/**
 * The formula a token may stand for (CONTEXT.md "Formula"): an existing
 * formula unit or an interjection headword. Null when the analyzer already
 * gave it that lemma (tak, dzięki) or the formula is suppressed.
 */
export function formulaHeadword(db: DB, surface: string, tokenLemma: string): string | null {
  const word = surface.trim().toLowerCase();
  if (word === tokenLemma.toLowerCase()) return null;
  const unit = formulaUnit(db, word);
  if (unit) return unit.suppressed ? null : word;
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
        const headword = formulaHeadword(db, tok.surface, corrected.lemma);
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

/** Formula detection over stored texts. */
export async function repairFormulas(db: DB, checker: MweChecker): Promise<FormulaRepair> {
  const moves = await formulaMoves(db, checker, (r) => formulaHeadword(db, r.surface, r.lemma));
  return db.transaction((tx) => applyFormulaMoves(tx, moves));
}

export interface FormulaClick {
  tokenId: number;
  surface: string;
  italian: string; // the occurrence gloss
  note: string | null; // usage note, kept in the formula's gloss
}

/**
 * Promote a clicked fixed use to a Formula unit (CONTEXT.md "Occurrence
 * gloss"). Past occurrences of the surface are checked first, so a check that
 * cannot run throws with nothing changed. Null when the formula is suppressed.
 */
export async function promoteFormula(
  db: DB,
  checker: MweChecker,
  click: FormulaClick,
): Promise<{ lemmaId: number; lemma: string; pos: string } | null> {
  const word = click.surface.trim().toLowerCase();
  if (formulaUnit(db, word)?.suppressed) return null;
  const meaning = click.note ? `${click.italian} (${click.note})` : click.italian;
  const moves = await formulaMoves(
    db,
    checker,
    (r) =>
      r.id !== click.tokenId &&
      r.surface.trim().toLowerCase() === word &&
      r.lemma.toLowerCase() !== word
        ? word
        : null,
    meaning,
  );

  return db.transaction((tx) => {
    const formulaId = upsertLemma(tx, word, FORMULA_POS);
    tx.insert(gloss)
      .values({ lemmaId: formulaId, sense: "", italian: meaning, provider: checker.name })
      .onConflictDoNothing()
      .run();
    const [clicked] = tx
      .select({ lemmaId: token.lemmaId })
      .from(token)
      .where(eq(token.id, click.tokenId))
      .all();
    applyFormulaMoves(tx, [
      ...moves,
      { id: click.tokenId, lemmaId: clicked.lemmaId!, headword: word },
    ]);
    tx.insert(occurrenceGloss)
      .values({
        tokenId: click.tokenId,
        lemmaId: formulaId,
        sense: null,
        italian: click.italian,
        provider: checker.name,
      })
      .onConflictDoNothing()
      .run();
    return { lemmaId: formulaId, lemma: word, pos: FORMULA_POS };
  });
}

/**
 * Mark a formula never-detect (CONTEXT.md "Suppressed formula"): its tokens go
 * back to the verb its word is a form of, and its knowledge, history and
 * glosses are removed. Throws when the word is no form of one dictionary verb.
 */
export function suppressFormula(db: DB, lemmaId: number): void {
  const [unit] = db
    .select({ word: lemma.lemma })
    .from(lemma)
    .where(and(eq(lemma.id, lemmaId), eq(lemma.pos, FORMULA_POS), eq(lemma.suppressed, false)))
    .all();
  if (!unit) return;
  const verb = correctLemma(db, unit.word, unit.word, "VERB");
  if (verb.lemma === unit.word || verb.pos !== "VERB") {
    throw new Error(`«${unit.word}» non è forma di un verbo del dizionario: non è una formula.`);
  }
  db.transaction((tx) => {
    const verbId = upsertLemma(tx, verb.lemma, "VERB");
    ensureReceptiveKnowledge(tx, verbId, new Date());
    tx.update(token).set({ lemmaId: verbId }).where(eq(token.lemmaId, lemmaId)).run();
    tx.update(lemma).set({ suppressed: true }).where(eq(lemma.id, lemmaId)).run();
    forgetUnit(tx, lemmaId);
  });
}

function formulaUnit(db: DB, word: string) {
  return db
    .select({ suppressed: lemma.suppressed })
    .from(lemma)
    .where(and(eq(lemma.lemma, word), eq(lemma.pos, FORMULA_POS)))
    .all()[0];
}

type WordToken = { id: number; surface: string; lemmaId: number; lemma: string };
type FormulaMove = { id: number; lemmaId: number; headword: string };

/** Word tokens `headwordOf` names a formula for, kept when the check accepts them in their sentence. */
async function formulaMoves(
  db: DB,
  checker: MweChecker,
  headwordOf: (r: WordToken) => string | null,
  meaning?: string,
): Promise<FormulaMove[]> {
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
    const headword = headwordOf(r);
    return headword
      ? [{ ...r, headword, meaning, sentence: sentenceText(db, r.textId, r.sentenceIndex) }]
      : [];
  });
  const accepted = await checkInContext(db, checker, "Formula", candidates);
  return candidates.filter((_, i) => accepted[i]);
}

/**
 * Move tokens to their formula unit, which starts with fresh knowledge, and
 * delete the lemmas left without tokens: their knowledge, history and glosses cascade.
 */
function applyFormulaMoves(tx: DB, moves: FormulaMove[]): FormulaRepair {
  if (moves.length === 0) return { moved: 0, deletedLemmas: 0 };
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
}

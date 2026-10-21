import { and, asc, eq, inArray, notExists, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "#/db/schema";
import {
  dictEntry,
  dictSense,
  gloss,
  knowledge,
  lemma,
  mweOccurrence,
  occurrenceGloss,
  passageQuestion,
  reviewLog,
  token,
} from "#/db/schema";
import { FORMULA_POS } from "#/import/classify";
import { ensureReceptiveKnowledge } from "#/import/pipeline";
import type { GlossProvider, MweCheckItem } from "#/llm/provider";
import { detectMwes, type MweMatch, type MweToken } from "./mwe";

type DB = BetterSQLite3Database<typeof schema>;
export type MweChecker = Pick<GlossProvider, "name" | "checkMwes">;

const ATTEMPTS = 3;

/**
 * Judge each candidate in its sentence (CONTEXT.md "Multi-word expression",
 * "Formula") with ONE provider call, retried. Throws, naming the provider and
 * the cause, when the check cannot run; no candidates means no call.
 * A candidate's `meaning` overrides the one looked up for its headword.
 */
export async function checkInContext(
  db: DB,
  checker: MweChecker,
  kind: "MWE" | "Formula",
  candidates: { headword: string; sentence: string; meaning?: string }[],
): Promise<boolean[]> {
  if (candidates.length === 0) return [];
  if (!checker.checkMwes) {
    throw new Error(`Provider "${checker.name}" cannot run the ${kind} check.`);
  }
  // A formula found by a click has no interjection senses: its gloss is its meaning.
  const meaning =
    kind === "MWE"
      ? (headword: string) => sensesOf(db, headword, eq(dictEntry.isMwe, true))
      : (headword: string) =>
          sensesOf(db, headword, eq(dictEntry.pos, "intj")) || formulaGloss(db, headword);
  const { items, itemOf } = checkItems(candidates, meaning);
  let cause: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const keep = await checker.checkMwes(items);
      return itemOf.map((i) => keep[i]);
    } catch (err) {
      cause = err;
    }
  }
  const reason = cause instanceof Error ? cause.message : String(cause);
  throw new Error(
    `${kind} check by provider "${checker.name}" failed ${ATTEMPTS} times: ${reason}`,
  );
}

/**
 * Check every stored MWE occurrence in its sentence and delete the rejected
 * ones. An MWE lemma left without occurrences is deleted with its knowledge
 * and history. Returns the number of occurrences dropped.
 */
export async function recheckMwes(db: DB, checker: MweChecker): Promise<number> {
  // ponytail: one prompt for every occurrence; chunk it if recheck outgrows one reply.
  const occurrences = db
    .select({
      id: mweOccurrence.id,
      lemmaId: mweOccurrence.lemmaId,
      textId: mweOccurrence.textId,
      sentenceIndex: mweOccurrence.sentenceIndex,
      headword: lemma.lemma,
    })
    .from(mweOccurrence)
    .innerJoin(lemma, eq(mweOccurrence.lemmaId, lemma.id))
    .all();
  const keep = await checkInContext(
    db,
    checker,
    "MWE",
    occurrences.map((o) => ({
      headword: o.headword,
      sentence: sentenceText(db, o.textId, o.sentenceIndex),
    })),
  );

  const rejected = occurrences.filter((_, k) => !keep[k]);
  if (rejected.length === 0) return 0;
  db.transaction((tx) => {
    tx.delete(mweOccurrence)
      .where(
        inArray(
          mweOccurrence.id,
          rejected.map((o) => o.id),
        ),
      )
      .run();
    tx.delete(lemma)
      .where(
        and(
          inArray(lemma.id, [...new Set(rejected.map((o) => o.lemmaId))]),
          eq(lemma.suppressed, false),
          notExists(tx.select().from(mweOccurrence).where(eq(mweOccurrence.lemmaId, lemma.id))),
        ),
      )
      .run();
  });
  return rejected.length;
}

/**
 * Mark an MWE never-detect and remove everything Practice could draw it from:
 * occurrences, knowledge, history, glosses and passage questions.
 */
export function suppressMwe(db: DB, lemmaId: number): void {
  db.transaction((tx) => {
    const { changes } = tx
      .update(lemma)
      .set({ suppressed: true })
      .where(and(eq(lemma.id, lemmaId), eq(lemma.pos, "MWE")))
      .run();
    if (changes === 0) return;
    tx.delete(mweOccurrence).where(eq(mweOccurrence.lemmaId, lemmaId)).run();
    forgetUnit(tx, lemmaId);
  });
}

/** Delete what Practice and the reader know of a unit: glosses, questions, knowledge, history. */
export function forgetUnit(db: DB, lemmaId: number): void {
  db.delete(gloss).where(eq(gloss.lemmaId, lemmaId)).run();
  db.delete(occurrenceGloss).where(eq(occurrenceGloss.lemmaId, lemmaId)).run();
  db.delete(passageQuestion).where(eq(passageQuestion.lemmaId, lemmaId)).run();
  db.delete(knowledge).where(eq(knowledge.lemmaId, lemmaId)).run();
  db.delete(reviewLog).where(eq(reviewLog.lemmaId, lemmaId)).run();
}

/**
 * Find a suppressed MWE again in every stored text (skipping spans another
 * occurrence already covers), check the matches in context, then lift the
 * suppression with the accepted ones. A failed check leaves it suppressed.
 */
export async function restoreMwe(db: DB, checker: MweChecker, lemmaId: number): Promise<void> {
  const [row] = db.select({ headword: lemma.lemma }).from(lemma).where(eq(lemma.id, lemmaId)).all();
  if (!row) return;
  const headwords = new Map([[row.headword.split(" ")[0].toLowerCase(), [row.headword]]]);

  const tokens = db
    .select({
      textId: token.textId,
      surface: token.surface,
      lemma: lemma.lemma,
      position: token.position,
      sentenceIndex: token.sentenceIndex,
    })
    .from(token)
    .leftJoin(lemma, eq(token.lemmaId, lemma.id))
    .where(eq(token.isSpace, false))
    .orderBy(asc(token.textId), asc(token.position))
    .all();
  const byText = new Map<number, MweToken[]>();
  for (const { textId, ...t } of tokens) {
    const list = byText.get(textId) ?? [];
    list.push({ ...t, isSpace: false });
    byText.set(textId, list);
  }

  const matches: (MweMatch & { textId: number })[] = [];
  for (const [textId, textTokens] of byText) {
    const taken = db
      .select({ start: mweOccurrence.startPosition, end: mweOccurrence.endPosition })
      .from(mweOccurrence)
      .where(eq(mweOccurrence.textId, textId))
      .all();
    for (const m of detectMwes(textTokens, headwords)) {
      if (taken.some((o) => m.startPosition <= o.end && o.start <= m.endPosition)) continue;
      matches.push({ ...m, textId });
    }
  }
  const keep = await checkInContext(
    db,
    checker,
    "MWE",
    matches.map((m) => ({
      headword: row.headword,
      sentence: sentenceText(db, m.textId, m.sentenceIndex),
    })),
  );
  const accepted = matches.filter((_, i) => keep[i]);

  db.transaction((tx) => {
    tx.update(lemma).set({ suppressed: false }).where(eq(lemma.id, lemmaId)).run();
    for (const m of accepted) {
      tx.insert(mweOccurrence)
        .values({
          textId: m.textId,
          lemmaId,
          startPosition: m.startPosition,
          endPosition: m.endPosition,
          sentenceIndex: m.sentenceIndex,
        })
        .run();
    }
    if (accepted.length > 0) ensureReceptiveKnowledge(tx, lemmaId, new Date());
  });
}

export function sentenceText(db: DB, textId: number, sentenceIndex: number): string {
  return db
    .select({ surface: token.surface })
    .from(token)
    .where(and(eq(token.textId, textId), eq(token.sentenceIndex, sentenceIndex)))
    .orderBy(asc(token.position))
    .all()
    .map((t) => t.surface)
    .join("")
    .trim();
}

/**
 * One check item per distinct (headword, sentence) pair, since identical pairs
 * share one verdict, and each candidate's item index.
 */
function checkItems(
  candidates: { headword: string; sentence: string; meaning?: string }[],
  meaning: (headword: string) => string,
): { items: MweCheckItem[]; itemOf: number[] } {
  const items: MweCheckItem[] = [];
  const index = new Map<string, number>();
  const itemOf = candidates.map((c) => {
    const { headword, sentence } = c;
    const key = `${headword}\n${sentence}`;
    let i = index.get(key);
    if (i === undefined) {
      i = items.push({ headword, meaning: c.meaning ?? meaning(headword), sentence }) - 1;
      index.set(key, i);
    }
    return i;
  });
  return { items, itemOf };
}

/** The inline gloss of a formula unit, or "" when it has none. */
function formulaGloss(db: DB, word: string): string {
  const [row] = db
    .select({ italian: gloss.italian })
    .from(gloss)
    .innerJoin(lemma, eq(gloss.lemmaId, lemma.id))
    .where(and(eq(lemma.lemma, word), eq(lemma.pos, FORMULA_POS), eq(gloss.sense, "")))
    .all();
  return row?.italian ?? "";
}

/** The headword's dictionary senses under `filter`, joined for a check prompt. */
function sensesOf(db: DB, headword: string, filter: SQL): string {
  return db
    .select({ gloss: dictSense.gloss })
    .from(dictSense)
    .innerJoin(dictEntry, eq(dictSense.entryId, dictEntry.id))
    .where(and(eq(dictEntry.word, headword), filter))
    .orderBy(asc(dictEntry.id), asc(dictSense.senseIndex))
    .all()
    .map((s) => s.gloss)
    .join("; ");
}

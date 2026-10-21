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
  passageQuestion,
  reviewLog,
  token,
} from "#/db/schema";
import { ensureReceptiveKnowledge } from "#/import/pipeline";
import type { GlossProvider, MweCheckItem } from "#/llm/provider";
import { detectMwes, type MweToken } from "./mwe";

type DB = BetterSQLite3Database<typeof schema>;
export type MweChecker = Pick<GlossProvider, "checkMwes">;

/**
 * Check MWE occurrences in their sentences with ONE provider call and delete
 * the rejected ones. An MWE lemma left without occurrences is deleted with its
 * knowledge and history. A provider without the capability, or a failed call,
 * keeps every occurrence. Returns the number of occurrences dropped.
 */
export async function checkMweOccurrences(
  db: DB,
  provider: MweChecker,
  scope: { textId?: number; lemmaId?: number } = {},
): Promise<number> {
  if (!provider.checkMwes) return 0;
  const where = and(
    scope.textId === undefined ? undefined : eq(mweOccurrence.textId, scope.textId),
    scope.lemmaId === undefined ? undefined : eq(mweOccurrence.lemmaId, scope.lemmaId),
  );
  // ponytail: one prompt for the whole scope; chunk it if recheck outgrows one reply.
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
    .where(where)
    .all();
  if (occurrences.length === 0) return 0;

  const { items, itemOf: occurrenceItem } = checkItems(
    occurrences.map((o) => ({
      headword: o.headword,
      sentence: sentenceText(db, o.textId, o.sentenceIndex),
    })),
    (headword) => sensesOf(db, headword, eq(dictEntry.isMwe, true)),
  );

  let keep: boolean[];
  try {
    keep = await provider.checkMwes(items);
  } catch (err) {
    console.warn("MWE check failed, keeping all matches:", err);
    return 0;
  }

  const rejected = occurrences.filter((_, k) => !keep[occurrenceItem[k]]);
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
    tx.delete(gloss).where(eq(gloss.lemmaId, lemmaId)).run();
    tx.delete(passageQuestion).where(eq(passageQuestion.lemmaId, lemmaId)).run();
    tx.delete(knowledge).where(eq(knowledge.lemmaId, lemmaId)).run();
    tx.delete(reviewLog).where(eq(reviewLog.lemmaId, lemmaId)).run();
  });
}

/**
 * Lift a suppression, find the MWE again in every stored text (skipping spans
 * another occurrence already covers) and check the new matches in context.
 */
export async function restoreMwe(db: DB, provider: MweChecker, lemmaId: number): Promise<void> {
  db.transaction((tx) => {
    const [row] = tx
      .update(lemma)
      .set({ suppressed: false })
      .where(eq(lemma.id, lemmaId))
      .returning({ headword: lemma.lemma })
      .all();
    if (!row) return;
    const headwords = new Map([[row.headword.split(" ")[0].toLowerCase(), [row.headword]]]);

    const tokens = tx
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

    let found = false;
    for (const [textId, textTokens] of byText) {
      const taken = tx
        .select({ start: mweOccurrence.startPosition, end: mweOccurrence.endPosition })
        .from(mweOccurrence)
        .where(eq(mweOccurrence.textId, textId))
        .all();
      for (const m of detectMwes(textTokens, headwords)) {
        if (taken.some((o) => m.startPosition <= o.end && o.start <= m.endPosition)) continue;
        tx.insert(mweOccurrence)
          .values({
            textId,
            lemmaId,
            startPosition: m.startPosition,
            endPosition: m.endPosition,
            sentenceIndex: m.sentenceIndex,
          })
          .run();
        found = true;
      }
    }
    if (found) ensureReceptiveKnowledge(tx, lemmaId, new Date());
  });
  await checkMweOccurrences(db, provider, { lemmaId });
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
export function checkItems(
  candidates: { headword: string; sentence: string }[],
  meaning: (headword: string) => string,
): { items: MweCheckItem[]; itemOf: number[] } {
  const items: MweCheckItem[] = [];
  const index = new Map<string, number>();
  const itemOf = candidates.map(({ headword, sentence }) => {
    const key = `${headword}\n${sentence}`;
    let i = index.get(key);
    if (i === undefined) {
      i = items.push({ headword, meaning: meaning(headword), sentence }) - 1;
      index.set(key, i);
    }
    return i;
  });
  return { items, itemOf };
}

/** The headword's dictionary senses under `filter`, joined for a check prompt. */
export function sensesOf(db: DB, headword: string, filter: SQL): string {
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

import { and, asc, desc, eq, gte, isNotNull, isNull, lte, ne, notExists, or } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "#/db/schema";
import { knowledge, lemma, mweOccurrence, passageQuestion, sourceText, token } from "#/db/schema";
import { knownLemmas } from "#/fsrs/index";
import type { AnalyzeResponse } from "#/import/sidecar";
import type { GlossProvider } from "#/llm/provider";
import { proofreadText } from "#/proofread/proofread";
import { NAME_POS } from "#/reader/name";
import { wordPattern } from "#/reader/word-pattern";

type DB = BetterSQLite3Database<typeof schema>;

/** LLM budget per background run. */
export const PREP_CAP = 20;
const PREP_HORIZON_DAYS = 2;

interface Occurrence {
  textId: number;
  sentenceIndex: number;
  target: string;
}

/** Plain imported texts count as read; an Episode only once marked read. */
const isReadText = or(isNull(sourceText.storyId), isNotNull(sourceText.readAt));

function sentenceSpan(db: DB, textId: number, from: number, to: number): string {
  return db
    .select({ surface: token.surface })
    .from(token)
    .where(
      and(eq(token.textId, textId), gte(token.sentenceIndex, from), lte(token.sentenceIndex, to)),
    )
    .orderBy(asc(token.position))
    .all()
    .map((t) => t.surface)
    .join("")
    .trim();
}

function occurrences(db: DB, lemmaId: number): Occurrence[] {
  const words = db
    .select({ textId: token.textId, sentenceIndex: token.sentenceIndex, target: token.surface })
    .from(token)
    .innerJoin(sourceText, eq(sourceText.id, token.textId))
    .where(and(eq(token.lemmaId, lemmaId), isReadText))
    .limit(20)
    .all();
  const mwes = db
    .select({
      textId: mweOccurrence.textId,
      sentenceIndex: mweOccurrence.sentenceIndex,
      start: mweOccurrence.startPosition,
      end: mweOccurrence.endPosition,
    })
    .from(mweOccurrence)
    .innerJoin(sourceText, eq(sourceText.id, mweOccurrence.textId))
    .where(and(eq(mweOccurrence.lemmaId, lemmaId), isReadText))
    .limit(20)
    .all()
    .map((m) => ({
      textId: m.textId,
      sentenceIndex: m.sentenceIndex,
      target: db
        .select({ surface: token.surface })
        .from(token)
        .where(
          and(eq(token.textId, m.textId), gte(token.position, m.start), lte(token.position, m.end)),
        )
        .orderBy(asc(token.position))
        .all()
        .map((t) => t.surface)
        .join(""),
    }));
  // Surfaces can carry their trailing whitespace.
  return [...words, ...mwes].map((o) => ({ ...o, target: o.target.trim() }));
}

/** Distinct sentences from read texts that hold the lemma, at most `max`. */
export function metSentences(db: DB, lemmaId: number, max = 3): string[] {
  const out = new Set<string>();
  for (const o of occurrences(db, lemmaId)) {
    if (out.size === max) break;
    out.add(sentenceSpan(db, o.textId, o.sentenceIndex, o.sentenceIndex));
  }
  return [...out];
}

/**
 * Up to 3 consecutive sentences from a read text, centred on the shortest
 * sentence holding the lemma. undefined when no read text has it.
 */
function realPassage(db: DB, lemmaId: number) {
  let best: (Occurrence & { length: number }) | undefined;
  for (const o of occurrences(db, lemmaId)) {
    const length = sentenceSpan(db, o.textId, o.sentenceIndex, o.sentenceIndex).length;
    if (!best || length < best.length) best = { ...o, length };
  }
  if (!best) return undefined;
  return {
    passage: sentenceSpan(db, best.textId, best.sentenceIndex - 1, best.sentenceIndex + 1),
    target: best.target,
    textId: best.textId,
  };
}

/** An LLM-written passage for the lemma, proofread and corrected with its target intact. */
async function generatedPassage(
  db: DB,
  provider: GlossProvider,
  analyze: (text: string) => Promise<AnalyzeResponse>,
  l: { lemma: string; pos: string },
) {
  const p = await provider.passage!({ lemma: l.lemma, pos: l.pos, knownLemmas: knownLemmas(db) });
  const { text } = await proofreadText(db, { provider, analyze }, p.passage);
  if (!wordPattern(p.target).test(text)) {
    throw new Error(`passage target ${JSON.stringify(p.target)} lost in correction`);
  }
  return { passage: text, target: p.target };
}

/**
 * Prepare one passage question per lemma lacking one: a real passage if a
 * read text has the lemma, else an LLM-written one, then one LLM call for the
 * question. A failure on a lemma caches nothing for it. Returns rows written.
 */
export async function preparePassages(
  db: DB,
  lemmaIds: number[],
  provider: GlossProvider,
  analyze: (text: string) => Promise<AnalyzeResponse>,
): Promise<number> {
  if (!provider.passage || !provider.passageQuestion) return 0;
  let written = 0;
  for (const lemmaId of lemmaIds) {
    const [l] = db
      .select({ lemma: lemma.lemma, pos: lemma.pos })
      .from(lemma)
      .where(
        and(
          eq(lemma.id, lemmaId),
          notExists(
            db
              .select({ id: passageQuestion.id })
              .from(passageQuestion)
              .where(eq(passageQuestion.lemmaId, lemmaId)),
          ),
        ),
      )
      .all();
    if (!l) continue;
    try {
      const real = realPassage(db, lemmaId);
      const p = real ?? (await generatedPassage(db, provider, analyze, l));
      const q = await provider.passageQuestion({
        passage: p.passage,
        lemma: l.lemma,
        target: p.target,
      });
      db.insert(passageQuestion)
        .values({
          lemmaId,
          passage: p.passage,
          target: p.target,
          source: real ? "text" : "generated",
          textId: real?.textId ?? null,
          question: q.question,
          choices: q.choices,
          correctIndex: q.correctIndex,
          provider: provider.name,
        })
        .run();
      written++;
    } catch (err) {
      console.error(`[passage] lemma ${lemmaId} (${l.lemma}) failed:`, err);
    }
  }
  return written;
}

/**
 * Lemmas worth a passage before they come up: receptive dues of the next 2
 * days with no prepared question, context-bound first (Passage is their only
 * receptive exercise), then by due date.
 */
export function passagePrepTargets(db: DB, now = new Date(), cap = PREP_CAP): number[] {
  const horizon = new Date(now);
  horizon.setDate(horizon.getDate() + PREP_HORIZON_DAYS);
  return db
    .select({ lemmaId: knowledge.lemmaId })
    .from(knowledge)
    .innerJoin(lemma, eq(lemma.id, knowledge.lemmaId))
    .where(
      and(
        eq(knowledge.track, "receptive"),
        lte(knowledge.due, horizon),
        isNull(lemma.flaggedAt),
        ne(lemma.pos, NAME_POS),
        notExists(
          db
            .select({ id: passageQuestion.id })
            .from(passageQuestion)
            .where(eq(passageQuestion.lemmaId, knowledge.lemmaId)),
        ),
      ),
    )
    .orderBy(desc(lemma.contextBound), asc(knowledge.due))
    .limit(cap)
    .all()
    .map((r) => r.lemmaId);
}

let preparing = false;

/**
 * Background run after a Practice session: fire-and-forget, one at a time
 * (a second trigger while one runs is dropped).
 */
export async function prepareUpcomingPassages(
  db: DB,
  provider: GlossProvider,
  analyze: (text: string) => Promise<AnalyzeResponse>,
): Promise<void> {
  if (preparing) return;
  preparing = true;
  try {
    await preparePassages(db, passagePrepTargets(db), provider, analyze);
  } finally {
    preparing = false;
  }
}

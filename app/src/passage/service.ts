import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  isNotNull,
  isNull,
  lte,
  ne,
  notExists,
  or,
} from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "#/db/schema";
import { knowledge, lemma, mweOccurrence, sourceText, token } from "#/db/schema";
import type { Llm } from "#/llm/call";
import { NAME_POS } from "#/reader/name";
import { passageQuestion } from "./llm";

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

/**
 * Prepare one passage question per lemma lacking one, from a read text that
 * has the lemma, with one LLM call for the question. A lemma without a read
 * sentence, or whose call fails, caches nothing. Returns rows written.
 */
export async function preparePassages(db: DB, lemmaIds: number[], llm: Llm): Promise<number> {
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
              .select({ id: schema.passageQuestion.id })
              .from(schema.passageQuestion)
              .where(eq(schema.passageQuestion.lemmaId, lemmaId)),
          ),
        ),
      )
      .all();
    if (!l) continue;
    const p = realPassage(db, lemmaId);
    if (!p) continue;
    try {
      const q = await llm.call(passageQuestion, {
        passage: p.passage,
        lemma: l.lemma,
        target: p.target,
      });
      db.insert(schema.passageQuestion)
        .values({
          lemmaId,
          passage: p.passage,
          target: p.target,
          source: "text",
          textId: p.textId,
          question: q.question,
          choices: q.choices,
          correctIndex: q.correctIndex,
          provider: llm.name,
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
 * days with a read sentence and no prepared question, context-bound first (Passage is their only
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
        or(
          exists(
            db
              .select({ id: token.id })
              .from(token)
              .innerJoin(sourceText, eq(sourceText.id, token.textId))
              .where(and(eq(token.lemmaId, knowledge.lemmaId), isReadText)),
          ),
          exists(
            db
              .select({ id: mweOccurrence.id })
              .from(mweOccurrence)
              .innerJoin(sourceText, eq(sourceText.id, mweOccurrence.textId))
              .where(and(eq(mweOccurrence.lemmaId, knowledge.lemmaId), isReadText)),
          ),
        ),
        notExists(
          db
            .select({ id: schema.passageQuestion.id })
            .from(schema.passageQuestion)
            .where(eq(schema.passageQuestion.lemmaId, knowledge.lemmaId)),
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
export async function prepareUpcomingPassages(db: DB, llm: Llm): Promise<void> {
  if (preparing) return;
  preparing = true;
  try {
    await preparePassages(db, passagePrepTargets(db), llm);
  } finally {
    preparing = false;
  }
}

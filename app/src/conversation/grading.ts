import { and, eq, inArray, isNull } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { State } from "ts-fsrs";
import * as schema from "#/db/schema";
import { type HelpLevel, knowledge, lemma } from "#/db/schema";
import { type Grade, gradeLemma, Rating, startOfDay, type Track } from "#/fsrs/index";
import { tokenLemma } from "#/import/pipeline";
import type { AnalyzeResponse } from "#/import/sidecar";
import { NAME_POS } from "#/reader/name";

type DB = BetterSQLite3Database<typeof schema>;

/** The met lemma ids `text` says: lemmas with a Knowledge state, never a Name or a reported lemma. */
export async function metLemmas(
  db: DB,
  analyze: (text: string) => Promise<AnalyzeResponse>,
  text: string,
): Promise<Set<number>> {
  if (!text.trim()) return new Set();
  const analysis = await analyze(text);
  const said = analysis.sentences
    .flatMap((s) => s.tokens)
    .flatMap((tok) => tokenLemma(db, tok, undefined) ?? [])
    .filter((l) => l.pos !== NAME_POS);
  if (said.length === 0) return new Set();
  const rows = db
    .selectDistinct({ id: lemma.id, lemma: lemma.lemma, pos: lemma.pos })
    .from(lemma)
    .innerJoin(knowledge, eq(knowledge.lemmaId, lemma.id))
    .where(
      and(
        inArray(
          lemma.lemma,
          said.map((l) => l.lemma),
        ),
        isNull(lemma.flaggedAt),
      ),
    )
    .all();
  const keys = new Set(said.map((l) => `${l.lemma}\t${l.pos}`));
  return new Set(rows.filter((r) => keys.has(`${r.lemma}\t${r.pos}`)).map((r) => r.id));
}

export interface TurnEvidence {
  said: Set<number>; // met lemmas in the learner's transcript
  echoes: Set<number>; // met lemmas in the character's last two lines
  hinted: Set<number>; // met lemmas of the Hint offered before the turn, if revealed
  help: HelpLevel | null;
}

/**
 * Grade an understood learner turn's lemmas (CONTEXT.md "Help ladder"). Echoes grade nothing. A
 * Model line read aloud is a Visible attempt: Pronunciation of the hinted lemmas said, for lemmas
 * past their first Receptive review, and no retrieval.
 */
export function gradeTurn(db: DB, { said, echoes, hinted, help }: TurnEvidence, now: Date): void {
  const lemmas = [...said].filter((id) => !echoes.has(id));
  if (help === "modelLine") {
    for (const id of lemmas.filter((l) => hinted.has(l) && receptiveReviewed(db, l))) {
      gradeFirst(db, id, "pronunciation", Rating.Good, now);
    }
    return;
  }
  for (const id of lemmas) {
    gradeFirst(db, id, "productive", hinted.has(id) ? Rating.Again : Rating.Good, now);
  }
}

/** The first evidence per lemma per track per day wins: a Conversation never stacks on Practice. */
function gradeFirst(db: DB, lemmaId: number, track: Track, rating: Grade, now: Date): void {
  const row = db
    .select({ lastReview: knowledge.lastReview })
    .from(knowledge)
    .where(and(eq(knowledge.lemmaId, lemmaId), eq(knowledge.track, track)))
    .get();
  if (row?.lastReview && row.lastReview >= startOfDay(now)) return;
  gradeLemma(db, lemmaId, track, rating, now);
}

function receptiveReviewed(db: DB, lemmaId: number): boolean {
  const row = db
    .select({ state: knowledge.state })
    .from(knowledge)
    .where(and(eq(knowledge.lemmaId, lemmaId), eq(knowledge.track, "receptive")))
    .get();
  return row !== undefined && row.state !== State.New;
}

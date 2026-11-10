import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "#/db/schema";
import { resolveFormulas } from "#/dictionary/formula";
import { checkInContext } from "#/dictionary/mwe-check";
import type { Llm } from "#/llm/call";
import { NAME_POS } from "#/reader/name";
import { resolveCharacterNames, storyCharacters, storyOf } from "#/story/character-names";
import { analysisMwes, analysisSentence, type ImportResult, persistAnalysis } from "./pipeline";
import type { AnalyzeResponse } from "./sidecar";

type DB = BetterSQLite3Database<typeof schema>;

/**
 * Import an analyzed text with its Formula candidates, Story character Names
 * and MWE matches checked in their sentences first, so a check that cannot run
 * fails the import with nothing saved.
 */
export async function importAnalysis(
  db: DB,
  llm: Llm,
  input: Parameters<typeof persistAnalysis>[1],
  analysis: AnalyzeResponse,
  // Injectable so tests stay dictionary-free.
  mweHeadwords?: Map<string, string[]>,
): Promise<ImportResult> {
  const assigned = await resolveFormulas(db, llm, analysis);
  const storyId = input.storyId ?? (input.textId === undefined ? null : storyOf(db, input.textId));
  if (storyId) {
    const characters = storyCharacters(db, storyId);
    for (const [position, name] of await resolveCharacterNames(db, llm, analysis, characters)) {
      assigned.set(position, { lemma: name, pos: NAME_POS });
    }
  }
  const matches = analysisMwes(db, analysis, assigned, mweHeadwords);
  const keep = await checkInContext(
    db,
    llm,
    "MWE",
    matches.map((m) => ({
      headword: m.headword,
      sentence: analysisSentence(analysis.sentences[m.sentenceIndex]),
    })),
  );
  const accepted = matches.filter((_, i) => keep[i]);
  return persistAnalysis(db, input, analysis, new Date(), mweHeadwords, assigned, accepted);
}

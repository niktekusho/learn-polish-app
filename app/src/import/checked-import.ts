import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "#/db/schema";
import { resolveFormulas } from "#/dictionary/formula";
import { checkInContext, type MweChecker } from "#/dictionary/mwe-check";
import { analysisMwes, analysisSentence, type ImportResult, persistAnalysis } from "./pipeline";
import type { AnalyzeResponse } from "./sidecar";

type DB = BetterSQLite3Database<typeof schema>;

/**
 * Import an analyzed text with its Formula candidates and MWE matches checked
 * in their sentences first, so a check that cannot run fails the import with
 * nothing saved.
 */
export async function importAnalysis(
  db: DB,
  checker: MweChecker,
  input: Parameters<typeof persistAnalysis>[1],
  analysis: AnalyzeResponse,
  // Injectable so tests stay dictionary-free.
  mweHeadwords?: Map<string, string[]>,
): Promise<ImportResult> {
  const formulas = await resolveFormulas(db, checker, analysis);
  const matches = analysisMwes(db, analysis, formulas, mweHeadwords);
  const keep = await checkInContext(
    db,
    checker,
    "MWE",
    matches.map((m) => ({
      headword: m.headword,
      sentence: analysisSentence(analysis.sentences[m.sentenceIndex]),
    })),
  );
  const accepted = matches.filter((_, i) => keep[i]);
  return persistAnalysis(db, input, analysis, new Date(), mweHeadwords, formulas, accepted);
}

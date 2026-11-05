import { inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "#/db/schema";
import { dictEntry, dictForm } from "#/db/schema";
import type { AnalyzeResponse, AnalyzedToken } from "#/import/sidecar";
import type { GlossProvider, ProofreadFlag } from "#/llm/provider";
import { isName } from "#/reader/name";

type DB = BetterSQLite3Database<typeof schema>;

export interface ProofreadDeps {
  provider: Pick<GlossProvider, "name" | "proofread" | "correct">;
  analyze: (text: string) => Promise<AnalyzeResponse>;
}

export interface Proofread {
  text: string; // corrected when anything was flagged
  analysis: AnalyzeResponse; // of `text`
  flags: ProofreadFlag[]; // what the first check flagged; empty for a clean text
  rounds: number; // Corrections it took; 0 for a clean text
}

export const CORRECTION_ROUNDS = 3;

const LETTER = /\p{L}/u;
export const NOT_IN_DICTIONARY = "not in the home dictionary";

/**
 * One flag per distinct non-name word absent from the home dictionary. Words
 * glued by hyphens pass when joined they are one, like syllabified "dzię-ku-ję".
 */
export function dictionaryFlags(
  analysis: AnalyzeResponse,
  inDictionary: (word: string) => boolean,
): ProofreadFlag[] {
  const flagged = new Set<string>();
  for (const run of gluedRuns(analysis)) {
    const words = run.filter((t) => LETTER.test(t.surface));
    const hyphenated = run.some((t) => t.surface.trim() === "-");
    if (
      hyphenated &&
      words.length > 1 &&
      inDictionary(words.map((t) => t.surface.trim()).join(""))
    ) {
      continue;
    }
    for (const t of words) {
      const word = t.surface.trim();
      if (!isName(t.pos) && !inDictionary(word)) flagged.add(word);
    }
  }
  return [...flagged].map((span) => ({ span, reason: NOT_IN_DICTIONARY }));
}

/** Tokens written without whitespace between them, per sentence. */
function gluedRuns(analysis: AnalyzeResponse): AnalyzedToken[][] {
  const runs: AnalyzedToken[][] = [];
  for (const s of analysis.sentences) {
    let run: AnalyzedToken[] = [];
    for (const t of s.tokens) {
      if (!t.is_space) run.push(t);
      if (t.is_space || /\s$/.test(t.surface)) {
        if (run.length) runs.push(run);
        run = [];
      }
    }
    if (run.length) runs.push(run);
  }
  return runs;
}

/**
 * Proofread a generated text; while flagged, correct what is left and proofread
 * again, CORRECTION_ROUNDS times at most. Throws, naming the provider, when a
 * check fails or flags remain.
 */
export async function proofreadText(
  db: DB,
  deps: ProofreadDeps,
  text: string,
  analysis?: AnalyzeResponse,
): Promise<Proofread> {
  const { provider } = deps;
  if (!provider.proofread || !provider.correct) {
    throw new Error(`Provider "${provider.name}" cannot proofread generated Polish.`);
  }
  const { proofread, correct } = provider;
  const withProvider = async <T>(what: string, call: Promise<T>): Promise<T> => {
    try {
      return await call;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`${what} by provider "${provider.name}" failed: ${reason}`);
    }
  };
  const inDictionary = homeDictionary(db);
  const check = async (t: string, a: AnalyzeResponse) => [
    ...dictionaryFlags(a, inDictionary),
    ...(await withProvider("Proofread", proofread.call(provider, t))),
  ];

  let current = { text, analysis: analysis ?? (await deps.analyze(text)) };
  const flags = await check(current.text, current.analysis);
  let left = flags;
  let rounds = 0;
  while (left.length > 0 && rounds < CORRECTION_ROUNDS) {
    const corrected = await withProvider("Correction", correct.call(provider, current.text, left));
    current = { text: corrected, analysis: await deps.analyze(corrected) };
    left = await check(current.text, current.analysis);
    rounds++;
  }
  if (left.length > 0) {
    throw new Error(
      `Correction by provider "${provider.name}" is still flagged: ` +
        left.map((f) => `«${f.span}»: ${f.reason}`).join("; "),
    );
  }
  return { ...current, flags, rounds };
}

/**
 * Whether a word is a home dictionary form or headword, ignoring case. An
 * empty dictionary knows every word, like the other dictionary checks.
 */
export function homeDictionary(db: DB): (word: string) => boolean {
  if (db.select({ id: dictEntry.id }).from(dictEntry).limit(1).all().length === 0)
    return () => true;
  return (word) => {
    const lower = word.toLowerCase();
    const spellings = [...new Set([word, lower, lower.charAt(0).toUpperCase() + lower.slice(1)])];
    return (
      db
        .select({ id: dictForm.id })
        .from(dictForm)
        .where(inArray(dictForm.form, spellings))
        .limit(1)
        .all().length > 0 ||
      db
        .select({ id: dictEntry.id })
        .from(dictEntry)
        .where(inArray(dictEntry.word, spellings))
        .limit(1)
        .all().length > 0
    );
  };
}

/**
 * What a Correction changed per paragraph and sentence, common words trimmed.
 * Where sentences no longer align, the paragraph is compared whole.
 */
export function textChanges(before: string, after: string): string[] {
  return changes(before, after, [/\n+/, /(?<=[.!?…])\s+/]);
}

function changes(before: string, after: string, splits: RegExp[]): string[] {
  if (before.trim() === after.trim()) return [];
  const [split, ...rest] = splits;
  const from = split ? before.trim().split(split) : [];
  const to = split ? after.trim().split(split) : [];
  if (!split || from.length !== to.length) return [wordChange(before, after)];
  return from.flatMap((part, i) => changes(part, to[i], rest));
}

function wordChange(before: string, after: string): string {
  const [a, b] = [before.trim().split(/\s+/), after.trim().split(/\s+/)];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a.at(-1 - end) === b.at(-1 - end)) {
    end++;
  }
  const span = (words: string[]) => words.slice(start, words.length - end).join(" ");
  return `"${span(a)}" → "${span(b)}"`;
}

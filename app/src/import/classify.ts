import { and, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "#/db/schema";
import { dictEntry } from "#/db/schema";
import { UPOS_TO_KAIKKI } from "#/dictionary/service";
import { isName } from "#/reader/name";

type DB = BetterSQLite3Database<typeof schema>;

// What an analyzed token becomes (CONTEXT.md "Tracked unit", "Name").
export type Classified =
  | { kind: "unit"; lemma: string; pos: string }
  | { kind: "name"; lemma: string }
  | { kind: "skip" };

// A Formula is tracked under the interjection POS (CONTEXT.md "Formula").
export const FORMULA_POS = "INTJ";

// UPOS tags that are layout/noise, not vocabulary worth tracking.
const SKIP_POS = new Set(["PUNCT", "SYM", "SPACE", "X"]);
const LETTER = /\p{L}/u;

/**
 * The one rule for turning an analyzed token into a tracked unit, a Name, or
 * nothing. Every path that writes tokens/lemmas from text goes through here.
 */
export function classifyToken(
  db: DB,
  tok: { lemma: string; pos: string; is_space: boolean },
): Classified {
  if (tok.is_space || SKIP_POS.has(tok.pos) || !LETTER.test(tok.lemma)) return { kind: "skip" };
  if (!isName(tok.pos)) return { kind: "unit", lemma: tok.lemma, pos: tok.pos };
  const common = commonWordPos(db, tok.lemma);
  if (common) return { kind: "unit", lemma: tok.lemma.toLowerCase(), pos: common };
  return { kind: "name", lemma: nameBase(db, tok.lemma) };
}

/**
 * UPOS of the Home dictionary's common-word entry for a capitalized word
 * (sentence-initial "Bułka"), or null when the word is a name or unknown.
 * A word with both entries ("Róża") stays a name.
 */
export function commonWordPos(db: DB, lemma: string): string | null {
  const lower = lemma.toLowerCase();
  const capital = capitalize(lower);
  if (hasNameEntry(db, lemma) || hasNameEntry(db, capital)) return null;
  const kaikki = new Set(
    db
      .select({ pos: dictEntry.pos })
      .from(dictEntry)
      .where(eq(dictEntry.word, lower))
      .all()
      .map((r) => r.pos),
  );
  for (const [upos, codes] of Object.entries(UPOS_TO_KAIKKI)) {
    if (!isName(upos) && codes.some((c) => kaikki.has(c))) return upos;
  }
  return null;
}

/**
 * Base form of a name lemma: capitalized, with an unlemmatized oblique form of
 * a feminine -a name ("Kasi", "Kasię", "Hanno") mapped to its dictionary name.
 * ponytail: -o skips -io (Mario is not Maria) but maps Paolo→Paola if the dictionary gains Paola.
 */
export function nameBase(db: DB, lemma: string): string {
  const base = capitalize(lemma);
  const stem = base.slice(0, -1);
  const candidates = [base];
  if (base.endsWith("i")) candidates.push(base + "a");
  if (/[ęąy]$/u.test(base) || /[^i]o$/u.test(base)) candidates.push(stem + "a");
  const found = db
    .select({ word: dictEntry.word })
    .from(dictEntry)
    .where(and(inArray(dictEntry.word, candidates), eq(dictEntry.pos, "name")))
    .all()
    .map((r) => r.word);
  return candidates.find((c) => found.includes(c)) ?? base;
}

function hasNameEntry(db: DB, word: string): boolean {
  return (
    db
      .select({ id: dictEntry.id })
      .from(dictEntry)
      .where(and(eq(dictEntry.word, word), eq(dictEntry.pos, "name")))
      .limit(1)
      .all().length > 0
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

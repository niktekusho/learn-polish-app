import { eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "#/db/schema";
import { dictEntry, dictForm } from "#/db/schema";
import { entriesForPos, UPOS_TO_KAIKKI } from "./service";

type DB = BetterSQLite3Database<typeof schema>;

/**
 * The small spaCy model returns the surface (pracujesz) or a related noun
 * (słucha -> słuch) for some verb forms. A lemma that is not a headword for
 * its POS is replaced by the one headword whose forms contain the surface.
 */
export function correctLemma(db: DB, surface: string, lemma: string, upos: string): string {
  // Proper nouns are classified separately, not looked up as vocabulary.
  if (upos === "PROPN") return lemma;
  const mapped = UPOS_TO_KAIKKI[upos] ?? [];
  if (mapped.length === 0 || entriesForPos(db, lemma, mapped).length > 0) return lemma;
  const form = surface.trim();
  const headwords = new Set(
    db
      .select({ word: dictEntry.word, pos: dictEntry.pos })
      .from(dictForm)
      .innerJoin(dictEntry, eq(dictForm.entryId, dictEntry.id))
      .where(inArray(dictForm.form, [form, form.toLowerCase()]))
      .all()
      .filter((r) => mapped.includes(r.pos))
      .map((r) => r.word),
  );
  return headwords.size === 1 ? [...headwords][0] : lemma;
}

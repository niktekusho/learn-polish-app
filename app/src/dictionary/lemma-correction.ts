import { eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "#/db/schema";
import { dictEntry, dictForm } from "#/db/schema";
import { isName } from "#/reader/name";
import { UPOS_TO_KAIKKI } from "./service";

type DB = BetterSQLite3Database<typeof schema>;

export interface LemmaTarget {
  lemma: string;
  pos: string; // UPOS
}

// kaikki pos -> the UPOS a lemma moved to that entry is saved under. Names are
// classified separately, so name entries are never a target.
const KAIKKI_TO_UPOS = new Map<string, string>();
for (const [upos, codes] of Object.entries(UPOS_TO_KAIKKI)) {
  if (isName(upos)) continue;
  for (const code of codes) if (!KAIKKI_TO_UPOS.has(code)) KAIKKI_TO_UPOS.set(code, upos);
}

/**
 * The small spaCy model returns the surface (pracujesz), a related noun
 * (słucha -> słuch) or the wrong POS (pieczywa -> pieczywać) for some forms.
 * Such a lemma is replaced by the one headword whose forms contain the surface.
 */
export function correctLemma(db: DB, surface: string, lemma: string, upos: string): LemmaTarget {
  // Proper nouns are classified separately, not looked up as vocabulary.
  if (isName(upos)) return { lemma, pos: upos };
  return slipTarget(db, lemma, upos, [surface]) ?? { lemma, pos: upos };
}

/**
 * The repair of a Lemma slip: the one headword whose forms contain every
 * surface, searched under the lemma's POS first, then under any POS when the
 * lemma is no headword at all. Null when the lemma stands or the forms are ambiguous.
 */
export function slipTarget(
  db: DB,
  lemma: string,
  upos: string,
  surfaces: string[],
): LemmaTarget | null {
  const mapped = UPOS_TO_KAIKKI[upos] ?? [];
  if (mapped.length === 0) return null;
  const headwordPos = new Set(
    db
      .select({ pos: dictEntry.pos })
      .from(dictEntry)
      .where(eq(dictEntry.word, lemma))
      .all()
      .map((r) => r.pos),
  );
  if (mapped.some((p) => headwordPos.has(p))) return null;

  const owners = formOwners(db, surfaces);
  const same = new Set(owners.filter((o) => mapped.includes(o.pos)).map((o) => o.word));
  if (same.size === 1) return { lemma: [...same][0], pos: upos };
  if (same.size > 1 || headwordPos.size > 0) return null;

  const cross = new Map<string, LemmaTarget>();
  for (const o of owners) {
    const pos = KAIKKI_TO_UPOS.get(o.pos);
    if (pos) cross.set(`${o.word}\t${pos}`, { lemma: o.word, pos });
  }
  return cross.size === 1 ? [...cross.values()][0] : null;
}

/** The (headword, kaikki pos) pairs whose forms contain every surface, case-insensitively. */
function formOwners(db: DB, surfaces: string[]): { word: string; pos: string }[] {
  const [first, ...rest] = [...new Set(surfaces.map((s) => s.trim()))].map(
    (surface) =>
      new Map(
        db
          .select({ word: dictEntry.word, pos: dictEntry.pos })
          .from(dictForm)
          .innerJoin(dictEntry, eq(dictForm.entryId, dictEntry.id))
          .where(inArray(dictForm.form, [surface, surface.toLowerCase()]))
          .all()
          .map((r) => [`${r.word}\t${r.pos}`, r] as const),
      ),
  );
  return [...(first ?? [])].filter(([k]) => rest.every((m) => m.has(k))).map(([, r]) => r);
}

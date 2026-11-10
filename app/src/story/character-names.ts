import { and, eq, ne } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "#/db/schema";
import { dictEntry, dictForm, lemma, sourceText, story, token } from "#/db/schema";
import { checkInContext, forgetUnit } from "#/dictionary/mwe-check";
import { analysisSentence, upsertLemma } from "#/import/pipeline";
import type { Llm } from "#/llm/call";
import { NAME_POS } from "#/reader/name";

type DB = BetterSQLite3Database<typeof schema>;

export interface Character {
  name: string;
  description: string; // the outline line, for the in-context check
}

const LETTER = /\p{L}/u;
export const CAPITAL = /^\p{Lu}/u;

/** The Story an Episode belongs to, or null for any other text. */
export function storyOf(db: DB, textId: number): number | null {
  const [t] = db
    .select({ storyId: sourceText.storyId })
    .from(sourceText)
    .where(eq(sourceText.id, textId))
    .all();
  return t?.storyId ?? null;
}

/**
 * The name each character of a Story goes by. An outline line puts the name
 * before its description, a title first: "Babcia Hanna – …" is Hanna.
 */
export function storyCharacters(db: DB, storyId: number): Character[] {
  const [s] = db.select({ outline: story.outline }).from(story).where(eq(story.id, storyId)).all();
  return (s?.outline.characters ?? []).flatMap((line) => {
    const head = line.split(/\s[\u2013\u2014-]\s|[:,(]/u)[0];
    const name = head
      .trim()
      .split(/\s+/)
      .at(-1)
      ?.replace(/[^\p{L}]/gu, "");
    return name ? [{ name, description: line }] : [];
  });
}

interface Form {
  character: Character;
  common: boolean; // also a form of a common word, so ambiguous at sentence start
}

/** Lowercase forms naming a character: the name, and the forms of the common word it also is. */
export function characterForms(db: DB, characters: Character[]): Map<string, Form> {
  const forms = new Map<string, Form>();
  for (const character of characters) {
    const word = character.name.toLowerCase();
    const common = db
      .select({ form: dictForm.form })
      .from(dictEntry)
      .leftJoin(dictForm, eq(dictForm.entryId, dictEntry.id))
      .where(and(eq(dictEntry.word, word), ne(dictEntry.pos, "name")))
      .all();
    forms.set(word, { character, common: common.length > 0 });
    for (const { form } of common) {
      if (form) forms.set(form.toLowerCase(), { character, common: true });
    }
  }
  return forms;
}

/**
 * The capitalized forms of a Story character's name in an analysis, as token
 * positions with the character's name (CONTEXT.md "Name"). At sentence start a
 * form that is also a common word is checked in its sentence first. Throws when
 * the check cannot run: nothing has been saved yet.
 */
export async function resolveCharacterNames(
  db: DB,
  llm: Llm,
  // An analysis, or stored tokens in position order: only surfaces are read.
  analysis: { sentences: { tokens: { surface: string }[] }[] },
  characters: Character[],
): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  const forms = characterForms(db, characters);
  if (forms.size === 0) return names;
  const candidates: { position: number; headword: string; meaning: string; sentence: string }[] =
    [];
  let position = 0;
  for (const s of analysis.sentences) {
    const sentence = analysisSentence(s);
    let start = true;
    for (const tok of s.tokens) {
      const word = tok.surface.trim();
      const form = CAPITAL.test(word) ? forms.get(word.toLowerCase()) : undefined;
      if (form && start && form.common) {
        candidates.push({
          position,
          headword: form.character.name,
          meaning: `nome proprio del personaggio ${form.character.description}`,
          sentence,
        });
      } else if (form) {
        names.set(position, form.character.name);
      }
      if (LETTER.test(word)) start = false;
      position++;
    }
  }
  const accepted = await checkInContext(db, llm, "Name", candidates);
  for (const c of candidates.filter((_, i) => accepted[i])) names.set(c.position, c.headword);
  return names;
}

export interface NameMove {
  tokenId: number;
  name: string;
}

/**
 * Relink tokens to the Name they are, and delete the lemmas left without
 * tokens: their knowledge was earned on a Name. Returns each moved token's
 * former lemma and the number of lemmas deleted.
 */
export function moveToNames(
  tx: DB,
  moves: NameMove[],
): { from: { tokenId: number; lemma: string; pos: string }[]; deletedLemmas: number } {
  const from = moves.flatMap((m) => {
    const [t] = tx
      .select({ lemmaId: lemma.id, lemma: lemma.lemma, pos: lemma.pos })
      .from(token)
      .innerJoin(lemma, eq(token.lemmaId, lemma.id))
      .where(eq(token.id, m.tokenId))
      .all();
    const nameId = upsertLemma(tx, m.name, NAME_POS);
    if (!t || t.lemmaId === nameId) return [];
    tx.update(token).set({ lemmaId: nameId }).where(eq(token.id, m.tokenId)).run();
    return [{ tokenId: m.tokenId, lemmaId: t.lemmaId, lemma: t.lemma, pos: t.pos }];
  });
  let deletedLemmas = 0;
  for (const id of new Set(from.map((f) => f.lemmaId))) {
    if (tx.select().from(token).where(eq(token.lemmaId, id)).limit(1).all().length > 0) continue;
    forgetUnit(tx, id);
    tx.delete(lemma).where(eq(lemma.id, id)).run();
    deletedLemmas++;
  }
  return { from: from.map(({ lemmaId: _, ...f }) => f), deletedLemmas };
}

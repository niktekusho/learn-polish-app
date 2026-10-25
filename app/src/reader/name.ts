import { CASE_NAMES, type CaseKey } from "./labels";

// A Name's lemma row carries this POS; no other lemma does.
export const NAME_POS = "PROPN";
export const isName = (pos: string | null | undefined) => pos === NAME_POS;

const NUMBERS: Record<string, string> = { Sing: "singolare", Plur: "plurale" };

export interface NameForm {
  word: string;
  base: string;
  case: { key: CaseKey; label: string; polish: string } | null;
  number: string | null;
}

/**
 * The tagger often calls an oblique name form nominative ("Kasi"), so a Nom tag drops the case:
 * "Kasi → Kasia" instead of "Kasi → Kasia · genitivo singolare (dopełniacz)".
 * Null when the surface is the base form (nominative or indeclinable).
 */
export function nameForm(surface: string, base: string, tags: string[] | null): NameForm | null {
  const word = surface.trim();
  if (word === base) return null;
  const feature = (k: string) => tags?.find((t) => t.startsWith(`${k}=`))?.slice(k.length + 1);
  const key = feature("Case")?.toLowerCase() as CaseKey | undefined;
  if (!key || key === "nom" || !CASE_NAMES[key]) return { word, base, case: null, number: null };
  return {
    word,
    base,
    case: { key, label: CASE_NAMES[key].it, polish: CASE_NAMES[key].pl },
    number: NUMBERS[feature("Number") ?? ""] ?? null,
  };
}

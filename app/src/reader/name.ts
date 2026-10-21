// A Name's lemma row carries this POS; no other lemma does.
export const NAME_POS = "PROPN";
export const isName = (pos: string | null | undefined) => pos === NAME_POS;

// UD Case value -> [Italian term, Polish term].
const CASES: Record<string, [string, string]> = {
  Gen: ["genitivo", "dopełniacz"],
  Dat: ["dativo", "celownik"],
  Acc: ["accusativo", "biernik"],
  Ins: ["strumentale", "narzędnik"],
  Loc: ["locativo", "miejscownik"],
  Voc: ["vocativo", "wołacz"],
};
const NUMBERS: Record<string, string> = { Sing: "singolare", Plur: "plurale" };

/**
 * The tagger often calls an oblique name form nominative ("Kasi"), so a Nom tag drops the case:
 * "Kasi → Kasia" instead of "Kasi → Kasia · genitivo singolare (dopełniacz)".
 * Null when the surface is the base form (nominative or indeclinable).
 */
export function nameLabel(surface: string, base: string, tags: string[] | null): string | null {
  const word = surface.trim();
  if (word === base) return null;
  const feature = (k: string) => tags?.find((t) => t.startsWith(`${k}=`))?.slice(k.length + 1);
  const terms = CASES[feature("Case") ?? ""];
  if (!terms) return `${word} → ${base}`;
  const number = NUMBERS[feature("Number") ?? ""];
  return `${word} → ${base} · ${[terms[0], number].filter(Boolean).join(" ")} (${terms[1]})`;
}

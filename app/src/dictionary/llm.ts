import { z } from "zod";
import type { CallSpec } from "#/llm/call";
import { parseJsonOutput } from "#/llm/json";

export interface MweCheckItem {
  headword: string;
  meaning: string; // English dictionary senses of the MWE or interjection
  sentence: string;
}

/**
 * ONE call per batch (CONTEXT.md "Multi-word expression", "Formula"): a dictionary
 * match can be a compositional phrase (*To jest chleb*) or a verb (*Proszę o chleb*),
 * so each is judged in its sentence.
 */
export const mweCheck: CallSpec<MweCheckItem[], boolean[]> = {
  name: "mwe-check",
  tier: "gloss",
  prompt: (items) =>
    "Sei un linguista polacco. Per ogni voce, decidi se nella frase le parole " +
    "indicate sono usate come espressione fissa con il significato dato (true) " +
    "oppure come parole separate con il loro senso normale (false). Esempio: " +
    '"to jest" = "that is to say" in "To jest chleb." è false. Un\'espressione può ' +
    'essere una sola parola: "proszę" = "please" in "Proszę o chleb." è false (verbo ' +
    '"chiedere"), in "Proszę – mówi Marco." è true. Un nome proprio pure: "Iskra" = ' +
    '"nome proprio del personaggio Iskra – piccolo drago" in "Iskra leci." è true, in ' +
    '"Iskra wyleciała z pieca." è false (scintilla). Rispondi SOLO con ' +
    'JSON valido, senza testo attorno, nel formato: {"keep":[true,false]} con un ' +
    "valore per voce, nello stesso ordine.\n\n" +
    items
      .map(
        (it, i) =>
          `${i + 1}. Espressione: ${it.headword}\nSignificato: ${it.meaning}\nFrase: ${it.sentence}`,
      )
      .join("\n\n"),
  parse: (text, items) => {
    const { keep } = parseJsonOutput(text, "MWE check", z.object({ keep: z.array(z.boolean()) }));
    if (keep.length !== items.length) {
      throw new Error(`MWE check returned ${keep.length} verdicts for ${items.length} items`);
    }
    return keep;
  },
  stub: (items) => items.map(() => true),
};

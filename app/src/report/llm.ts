import { z } from "zod";
import type { CallSpec } from "#/llm/call";
import { parseJsonOutput } from "#/llm/json";

export interface ReportReviewItem {
  lemma: string;
  pos: string;
  note: string | null;
  gloss: string | null; // current primary gloss
  manual: boolean; // the primary gloss is a Manual gloss
  contextBound: boolean;
  senses: { index: number; gloss: string; italian: string }[];
  sentences: string[];
  // Capitalized occurrences that may be a Name (CONTEXT.md "Report review").
  names: { index: number; surface: string; sentence: string }[];
  previous: {
    glossBefore: string | null;
    glossAfter: string | null;
    markBefore: boolean;
    markAfter: boolean;
    reason: string;
    undone: boolean;
  } | null;
}

export type GlossVerdict = "keep" | { sense: number } | { italian: string; noSenseFits: boolean };

export interface ReportVerdict {
  gloss: GlossVerdict;
  contextBound: boolean;
  names: number[]; // indices of the item's Name candidates that are a Name
  reason: string;
}

const yesNo = (b: boolean) => (b ? "sì" : "no");

function reportItemText(it: ReportReviewItem, n: number): string {
  const lines = [
    `${n}. Lemma: ${it.lemma} (${it.pos})`,
    `Nota dello studente: ${it.note ? `«${it.note}»` : "(nessuna)"}`,
    `Glossa attuale: ${it.gloss ?? "(nessuna)"}${it.manual ? " [manuale: tienila]" : ""}`,
    `Dipendente dal contesto: ${yesNo(it.contextBound)}`,
    `Sensi:\n${it.senses.map((s) => `${s.index}. ${s.gloss} (${s.italian})`).join("\n") || "(nessuno)"}`,
    `Frasi:\n${it.sentences.map((s) => `- ${s}`).join("\n") || "(nessuna)"}`,
  ];
  if (it.names.length > 0) {
    lines.push(
      `Occorrenze con maiuscola:\n${it.names.map((c) => `${c.index}. «${c.surface.trim()}» in: ${c.sentence}`).join("\n")}`,
    );
  }
  const p = it.previous;
  if (p) {
    lines.push(
      `Revisione precedente${p.undone ? " (annullata dallo studente)" : ""}: glossa «${p.glossBefore ?? "-"}» → «${p.glossAfter ?? "-"}», contesto ${yesNo(p.markBefore)} → ${yesNo(p.markAfter)}. Motivo: ${p.reason}`,
    );
  }
  return lines.join("\n");
}

const reportVerdict = z.object({
  gloss: z.union([
    z.literal("keep"),
    z.object({ sense: z.number().int().min(0) }),
    z.object({ italian: z.string().trim().min(1).max(60), noSenseFits: z.boolean() }),
  ]),
  contextBound: z.boolean(),
  names: z.array(z.number().int().min(0)).default([]),
  reason: z.string().trim().min(1).max(300),
});

/**
 * ONE call per batch. The model picks a numbered dictionary sense whose Italian
 * already exists; free Italian is for when none fits (AGENTS.md deterministic first).
 */
export const reportReview: CallSpec<ReportReviewItem[], (ReportVerdict | null)[]> = {
  name: "report-review",
  tier: "story",
  prompt: (items) =>
    "Sei un lessicografo polacco-italiano. Uno studente italiano principiante ha " +
    "segnalato queste parole polacche: qualcosa non va, la sua nota dice cosa pensa. " +
    'Per ogni voce prendi tre decisioni indipendenti. gloss, la glossa principale: "keep" se va bene; ' +
    '{"sense":N} per sostituirla con la glossa italiana del senso N; ' +
    '{"italian":"...","noSenseFits":true} (1-4 parole) solo se nessun senso va bene o ' +
    'non ci sono sensi. Una glossa manuale si tiene sempre: "keep". contextBound: true ' +
    'se la parola non si può tradurre da sola senza una frase (es. "do" = "a", "fino a", ' +
    '"in" o "per" a seconda della frase), false se una glossa breve basta (es. "też" = ' +
    '"anche"). names: i numeri delle occorrenze con maiuscola che nella loro frase sono ' +
    'un nome proprio (il drago "Iskra" in "Smok Iskra leci."), non la parola comune ' +
    '("Iskra wyleciała z pieca." è una scintilla); [] se nessuna o se non ce ne sono. ' +
    "reason: una riga in italiano che spiega le decisioni. Una " +
    "revisione precedente annullata è stata rifiutata dallo studente: non ripeterla. " +
    "Rispondi SOLO con JSON valido, senza testo attorno, nel formato: " +
    '{"reviews":[{"gloss":"keep","contextBound":false,"names":[],"reason":"..."}]} con una voce ' +
    "per parola, nello stesso ordine.\n\n" +
    items.map((it, i) => reportItemText(it, i + 1)).join("\n\n"),
  // A malformed item is null: it stays pending while the others apply.
  parse: (text, items) => {
    const { reviews } = parseJsonOutput(
      text,
      "report review",
      z.object({ reviews: z.array(z.unknown()) }),
    );
    if (reviews.length !== items.length) {
      throw new Error(
        `report review returned ${reviews.length} verdicts for ${items.length} items`,
      );
    }
    return reviews.map((r) => reportVerdict.safeParse(r).data ?? null);
  },
  stub: (items) =>
    items.map((it) => ({
      gloss: it.senses.length > 0 ? { sense: 0 } : "keep",
      contextBound: it.contextBound,
      names: [],
      reason: "Revisione stub.",
    })),
};

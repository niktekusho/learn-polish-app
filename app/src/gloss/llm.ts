import { z } from "zod";
import type { CallSpec } from "#/llm/call";
import { parseJsonOutput } from "#/llm/json";

export interface GlossRequest {
  lemma: string;
  pos: string;
  sentence: string; // the sentence the lemma appeared in, for disambiguation
}

const MAX_GLOSS_LEN = 60;

/** Sentence-context gloss of a lemma the Home dictionary lacks: free Italian. */
export const sentenceGloss: CallSpec<GlossRequest, string> = {
  name: "gloss",
  tier: "gloss",
  // The model glosses ONLY the lemma, in dictionary form; the sentence picks the sense.
  // Without that rule "ciekawych rzeczy" made "rzecz" gloss as "cose interessanti".
  prompt: (req) =>
    "Sei un dizionario polacco-italiano. Usa la frase SOLO come contesto per " +
    "scegliere il senso giusto. Fornisci la glossa italiana del SOLO lemma " +
    "indicato, nella sua forma base di dizionario. NON tradurre la frase " +
    "intera né le parole vicine (aggettivi, articoli): glossa solo il lemma. " +
    "Rispondi SOLO con la glossa italiana (1-4 parole), senza ripetere la " +
    "parola polacca, senza frecce, spiegazioni né punteggiatura finale.\n\n" +
    `Lemma: ${req.lemma}\nPOS: ${req.pos}\nFrase: ${req.sentence}`,
  // A bad gloss written to the cache becomes permanent (#6), so junk throws. The model
  // sometimes echoes the surface form as "swoich → proprio": the gloss is after the arrow.
  parse: (text) => {
    const out = text.trim().replace(/^.*(?:→|->|=>)\s*/, "");
    if (!out || out.length > MAX_GLOSS_LEN) {
      throw new Error(`unexpected gloss output: ${JSON.stringify(out.slice(0, 80))}`);
    }
    return out;
  },
  stub: (req) => `«${req.lemma}»: glossa stub (${req.pos})`,
};

export interface SenseGlossRequest {
  lemma: string;
  pos: string;
  surface: string; // the clicked form, judged for a fixed use
  sentence: string;
  senses: { index: number; gloss: string }[]; // English Wiktionary senses
}

/**
 * What one occurrence means in its sentence (CONTEXT.md "Occurrence gloss"):
 * the fitting sense, or free Italian with whether the form is a fixed use.
 */
export type OccurrenceResult =
  | { index: number }
  | { italian: string; fixed: boolean; note: string | null };

export interface SenseGlossResult {
  translations: { index: number; italian: string }[]; // ALL senses translated
  bestIndex: number; // sense fitting the sentence, always a dictionary sense
  occurrence: OccurrenceResult;
}

export interface OccurrenceRequest {
  lemma: string;
  pos: string;
  surface: string;
  sentence: string;
  senses: { index: number; gloss: string; italian: string }[];
}

const OCCURRENCE_RULE =
  "Per la forma nella frase: se uno dei sensi si adatta, rispondi " +
  '{"index":N}; se nessuno si adatta, rispondi {"italian":"...","fixed":true|false,' +
  '"note":"..."|null} con la traduzione italiana in questa frase (1-4 parole). ' +
  "fixed è true solo se la forma flessa è usata come espressione fissa, e allora " +
  'note è una breve nota d\'uso. Esempio: "Poproszę" in "Poproszę chleb." = ' +
  '{"italian":"vorrei","fixed":true,"note":"ordinando, cortese"}.';

const occurrenceResponse = z.union([
  z.object({ index: z.number().int().min(0) }),
  z.object({
    italian: z.string().trim().min(1).max(MAX_GLOSS_LEN),
    fixed: z.boolean(),
    note: z.string().trim().min(1).max(MAX_GLOSS_LEN).nullable(),
  }),
]);

const senseGlossResponse = z.object({
  translations: z
    .array(
      z.object({
        index: z.number().int().min(0),
        italian: z.string().trim().min(1).max(MAX_GLOSS_LEN),
      }),
    )
    .min(1),
  bestIndex: z.number().int().min(0),
  occurrence: occurrenceResponse,
});

function checkOccurrence(occurrence: OccurrenceResult, senseCount: number): OccurrenceResult {
  if ("index" in occurrence && occurrence.index >= senseCount) {
    throw new Error(`occurrence index ${occurrence.index} out of range (${senseCount})`);
  }
  return occurrence;
}

/**
 * ONE call per lemma (ADR-0002): it translates every Wiktionary sense, flags the
 * sense the sentence uses and answers for the clicked occurrence.
 */
export const senseGloss: CallSpec<SenseGlossRequest, SenseGlossResult> = {
  name: "sense-gloss",
  tier: "gloss",
  prompt: (req) =>
    "Sei un dizionario polacco-italiano. Il lemma polacco ha i seguenti sensi " +
    "(dal Wiktionary inglese). Traduci OGNI senso in una glossa italiana breve " +
    "(1-4 parole, forma base di dizionario). Poi indica in bestIndex il senso più " +
    "vicino a quello usato nella frase data. " +
    OCCURRENCE_RULE +
    " Rispondi SOLO con JSON valido, senza testo attorno, nel formato: " +
    '{"translations":[{"index":0,"italian":"..."}],"bestIndex":0,"occurrence":{"index":0}}\n\n' +
    `Lemma: ${req.lemma}\nPOS: ${req.pos}\nForma: ${req.surface}\nFrase: ${req.sentence}\nSensi:\n` +
    req.senses.map((s) => `${s.index}. ${s.gloss}`).join("\n"),
  parse: (text, req) => {
    const senseCount = req.senses.length;
    const parsed = parseJsonOutput(text, "sense gloss", senseGlossResponse);
    for (const t of parsed.translations) {
      if (t.index >= senseCount) {
        throw new Error(`sense gloss translation index ${t.index} out of range (${senseCount})`);
      }
    }
    if (!parsed.translations.some((t) => t.index === parsed.bestIndex)) {
      throw new Error(`bestIndex ${parsed.bestIndex} not among translations`);
    }
    checkOccurrence(parsed.occurrence, senseCount);
    return parsed;
  },
  stub: (req) => ({
    translations: req.senses.map((s) => ({ index: s.index, italian: `IT:${s.gloss}` })),
    bestIndex: 0,
    occurrence: { index: 0 },
  }),
};

/** The occurrence gloss of a lemma already glossed. */
export const occurrenceGloss: CallSpec<OccurrenceRequest, OccurrenceResult> = {
  name: "occurrence",
  tier: "gloss",
  prompt: (req) =>
    "Sei un dizionario polacco-italiano. Ecco i sensi del lemma polacco (inglese, " +
    "con la glossa italiana). " +
    OCCURRENCE_RULE +
    " Rispondi SOLO con JSON valido, senza testo attorno.\n\n" +
    `Lemma: ${req.lemma}\nPOS: ${req.pos}\nForma: ${req.surface}\nFrase: ${req.sentence}\nSensi:\n` +
    (req.senses.map((s) => `${s.index}. ${s.gloss} (${s.italian})`).join("\n") || "(nessuno)"),
  parse: (text, req) =>
    checkOccurrence(parseJsonOutput(text, "occurrence", occurrenceResponse), req.senses.length),
  stub: (req) =>
    req.senses.length > 0
      ? { index: 0 }
      : { italian: `«${req.surface}»: occorrenza stub`, fixed: false, note: null },
};

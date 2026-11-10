import { z } from "zod";
import type { CallSpec } from "#/llm/call";
import { parseJsonOutput, stripFences } from "#/llm/json";

// Proofread and Correction (CONTEXT.md) are calls of their own: a model
// reviewing its draft in the drafting call keeps its own mistakes.

/** A flagged span: its exact text in the proofread text, and why. */
export interface ProofreadFlag {
  span: string;
  reason: string;
}

export interface CorrectionRequest {
  text: string;
  flags: ProofreadFlag[];
}

// The longest Episode, and so the longest correction: a correction is never much longer than its text.
export const MAX_TEXT_LEN = 4000;

/** The errors a native speaker would flag in a generated Polish text. */
export const proofread: CallSpec<string, ProofreadFlag[]> = {
  name: "proofread",
  tier: "check",
  prompt: (text) =>
    "Sei un correttore di bozze madrelingua polacco. Il testo polacco qui sotto è per " +
    "uno studente principiante: frasi semplici sono volute. Segnala ciò che un " +
    "madrelingua giudicherebbe sbagliato o non direbbe mai così: accordo di " +
    "genere, numero e caso, reggenze, forme verbali sbagliate, parole che non esistono " +
    "in polacco, e calchi dall'italiano: parole tutte esistenti ma in una costruzione " +
    "che un madrelingua non userebbe (es. 'mam zimno' per 'avere freddo': si dice " +
    "'jest mi zimno'; 'ma trochę strachu' per 'ha un po' di paura': 'trochę się " +
    "boi'; 'chcę ciepły dom': 'chcę mieszkać w ciepłym domu'; 'dlaczego jesteś " +
    "tu': 'dlaczego tutaj jesteś'). In questi casi proponi nella reason la forma " +
    "naturale. Prima di segnalare, controlla chi è il soggetto e cosa intende la frase " +
    "(es. 'Marco chce' è giusto: terza persona). Lo stile NON è un errore: non segnalare " +
    "frasi naturali che si potrebbero dire meglio, scelte di parole possibili, ripetizioni. " +
    "Se non sei sicuro che un madrelingua direbbe la frase così, segnalala. Rileggi " +
    "tutto il testo fino alla fine ed elenca OGNI " +
    "errore, ogni occorrenza a sé anche quando lo stesso errore si ripete. Per ogni " +
    "errore, span è il testo sbagliato copiato " +
    'ESATTAMENTE dal testo (con le parole che concordano, es. "Duża torta") e reason una ' +
    "breve spiegazione. Rispondi SOLO con JSON valido, senza testo attorno, nel formato: " +
    '{"errors":[{"span":"...","reason":"..."}]}; senza errori: {"errors":[]}\n\n' +
    `Testo:\n${text}`,
  parse: (reply, text) => {
    const { errors } = parseJsonOutput(
      reply,
      "proofread",
      z.object({
        errors: z.array(
          z.object({ span: z.string().trim().min(1), reason: z.string().trim().min(1) }),
        ),
      }),
    );
    for (const e of errors) {
      if (!text.includes(e.span)) {
        throw new Error(`proofread span ${JSON.stringify(e.span)} not in the text`);
      }
    }
    return errors;
  },
  stub: () => [],
};

/** The text with only its flagged errors corrected. */
export const correction: CallSpec<CorrectionRequest, string> = {
  name: "correction",
  tier: "story",
  prompt: (req) =>
    "Sei un correttore di bozze madrelingua polacco. Il testo polacco qui sotto ha gli " +
    "errori elencati. Correggi SOLO quelli, con la modifica più piccola che rende la " +
    "frase corretta e ne conserva il significato, insieme alle parole che concordano " +
    "con le parti corrette (aggettivi, verbi, pronomi), anche nel resto del testo. Una " +
    "parola che non esiste in polacco va sostituita con la parola polacca giusta. Lo " +
    "stesso errore, dove si ripete nel testo, va corretto anche lì. Non " +
    "cambiare nient'altro: stessa storia, stesse frasi, stessa punteggiatura e a capo. " +
    "Rispondi SOLO con il testo corretto, senza commenti.\n\n" +
    `Errori:\n${req.flags.map((f) => `- «${f.span}»: ${f.reason}`).join("\n")}\n\n` +
    `Testo:\n${req.text}`,
  parse: (reply) => {
    const text = stripFences(reply).trim();
    if (!text || text.length > MAX_TEXT_LEN) {
      throw new Error(`unexpected correction output: ${JSON.stringify(text.slice(0, 80))}`);
    }
    return text;
  },
  // ponytail: drops the flagged spans; a stub cannot know the right Polish word.
  stub: (req) =>
    req.flags
      .reduce((t, f) => t.replaceAll(f.span, ""), req.text)
      .replace(/ {2,}/g, " ")
      .replace(/ ([.,!?])/g, "$1")
      .trim(),
};

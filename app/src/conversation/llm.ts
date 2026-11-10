import { z } from "zod";
import type { DebriefCorrection } from "#/db/schema";
import type { CallSpec } from "#/llm/call";
import type { TranscriptLine } from "#/llm/conversation-session";
import { parseJsonOutput } from "#/llm/json";

export interface SceneRequest {
  episode: string; // the Episode the scene follows
  characters: string[]; // the Story outline's character lines
  profile: Record<"name" | "job" | "city" | "partner" | "hobbies", string>;
  dueLemmas: string[];
  voices: { id: string; label: string }[] | null; // set when the Story has no voices yet
  memory: string[][]; // each character's Character memory lines, in `characters` order
}

export interface SceneResult {
  character: number; // index into the request's characters
  scene: string;
  steps: string[]; // Italian Goal steps, in card order
  roleFacts: string | null;
  opening: { line: string; italian: string; hint: string[]; modelLine: string };
  voices: string[] | null; // one catalog id per character, when the request had voices
}

const memoryLine = (lines: string[] = []) =>
  lines.length > 0 ? `\n   Ricordi sullo studente: ${lines.join(" ")}` : "";

const sceneResponse = z.object({
  character: z.number().int().min(0),
  scene: z.string().trim().min(1),
  steps: z.array(z.string().trim().min(1)).min(2).max(4),
  roleFacts: z.string().trim().min(1).nullable(),
  opening: z.object({
    line: z.string().trim().min(1),
    italian: z.string().trim().min(1),
    hint: z.array(z.string().trim().min(1)),
    modelLine: z.string().trim().min(1),
  }),
  voices: z.array(z.string()).nullable().default(null),
});

/**
 * ONE story-tier call per scene (CONTEXT.md "Conversation", "Goal"), outside the turn loop.
 * The model picks a character and voices by key, checked against the outline and the
 * catalog; Goal step ids are not its job.
 */
export const scene: CallSpec<SceneRequest, SceneResult> = {
  name: "scene",
  tier: "story",
  prompt: (req) => {
    const p = req.profile;
    const due = req.dueLemmas.length
      ? `Parole che lo studente sta ripassando: ${req.dueLemmas.join(", ")}. Scegli l'obiettivo ` +
        "in modo che qualcuna di queste sia la risposta naturale. "
      : "";
    const voices = req.voices
      ? "voices: per ogni personaggio, nello stesso ordine dell'elenco, l'id della voce più " +
        "adatta tra queste (più personaggi possono avere la stessa voce):\n" +
        req.voices.map((v) => `- ${v.id}: ${v.label}`).join("\n") +
        "\n"
      : "voices: null.\n";
    return (
      "Prepara una scena di conversazione parlata in polacco per uno studente italiano " +
      "principiante (sotto A1). La scena si svolge subito dopo l'episodio qui sotto, tra lo " +
      "studente e uno dei personaggi della storia. Lo studente interpreta se stesso, dal suo " +
      "profilo. " +
      due +
      "Campi:\n" +
      "character: il numero del personaggio nell'elenco (da 0).\n" +
      "scene: dove e quando avviene la scena, una frase in italiano.\n" +
      "steps: da 2 a 4 passi dell'obiettivo dello studente, in italiano, brevi e concreti " +
      "(es. «Compra due panini», «Paga»), ognuno fattibile con una frase semplice.\n" +
      "roleFacts: se l'obiettivo assegna allo studente un ruolo, i fatti di quel ruolo in " +
      "italiano (es. «Hai una prenotazione a nome Rossi per due notti»), altrimenti null.\n" +
      "opening: la prima battuta del personaggio. line: in polacco, una o due frasi brevi " +
      "con parole comuni; italian: la sua traduzione italiana; hint: da 2 a 4 parole " +
      "polacche chiave, in forma base, per la probabile risposta dello studente; " +
      "modelLine: una frase polacca breve e completa che lo studente potrebbe rispondere.\n" +
      voices +
      "Rispondi SOLO con JSON valido, senza testo attorno, nel formato: " +
      '{"character":0,"scene":"...","steps":["..."],"roleFacts":null,' +
      '"opening":{"line":"...","italian":"...","hint":["..."],"modelLine":"..."},"voices":null}\n\n' +
      `Profilo dello studente: si chiama ${p.name}, lavoro: ${p.job}, vive a ${p.city}, ` +
      `partner: ${p.partner}, hobby: ${p.hobbies}.\n` +
      `Personaggi:\n${req.characters.map((c, i) => `${i}. ${c}${memoryLine(req.memory[i])}`).join("\n")}\n\n` +
      `Episodio:\n${req.episode}`
    );
  },
  parse: (text, req) => {
    const parsed = parseJsonOutput(text, "scene", sceneResponse);
    if (parsed.character >= req.characters.length) {
      throw new Error(
        `scene character ${parsed.character} out of range (${req.characters.length})`,
      );
    }
    if (!req.voices) return { ...parsed, voices: null };
    const ids = new Set(req.voices.map((v) => v.id));
    if (
      parsed.voices?.length !== req.characters.length ||
      !parsed.voices.every((v) => ids.has(v))
    ) {
      throw new Error(`scene voices ${JSON.stringify(parsed.voices)} do not match the catalog`);
    }
    return parsed;
  },
  // Matches the ScriptedSession's bakery script, so dev plays one coherent scene.
  stub: (req) => ({
    character: 0,
    scene: "Mattina, in panetteria (scena stub).",
    steps: ["Compra due panini", "Dì che è tutto", "Paga"],
    roleFacts: null,
    opening: {
      line: "Dzień dobry! W czym mogę pomóc?",
      italian: "Buongiorno! Come posso aiutarla?",
      hint: ["poproszę", "bułka"],
      modelLine: "Poproszę dwie bułki.",
    },
    voices: req.voices && req.characters.map((_, i) => req.voices![i % req.voices!.length].id),
  }),
};

export const MAX_CORRECTIONS = 10;
export const MAX_MEMORY_LINES = 5;

export interface DebriefRequest {
  transcript: TranscriptLine[]; // the opening, then each learner turn and its reply
  character: string; // the outline line of the character the learner spoke with
  memory: string[]; // that character's Character memory before this Conversation
}

/** The Debrief call also rewrites the character's memory, so memory costs no extra call. */
export interface DebriefResult {
  corrections: DebriefCorrection[];
  memory: string[];
}

const correction = z.object({
  said: z.string().trim().min(1),
  corrected: z.string().trim().min(1),
  italian: z.string().trim().min(1),
});

// Case, punctuation and spacing differ between a transcript and a quote of it.
const normalized = (text: string) =>
  text
    .toLowerCase()
    .replace(/[\p{P}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * ONE call when the scene ends (CONTEXT.md "Debrief"). A correction quotes the learner's own
 * words, checked against what they said, so the Debrief never corrects a sentence nobody spoke.
 */
export const debrief: CallSpec<DebriefRequest, DebriefResult> = {
  name: "debrief",
  tier: "story",
  prompt: (req) => {
    const lines = req.transcript.map(
      (l) => `${l.speaker === "character" ? "Personaggio" : "Studente"}: ${l.text}`,
    );
    return (
      "Sei un insegnante di polacco. Uno studente italiano principiante (sotto A1) ha fatto " +
      "questa conversazione parlata; le sue battute vengono dal riconoscimento vocale. " +
      `Correggi i suoi errori di polacco: al massimo ${MAX_CORRECTIONS} correzioni, prima gli ` +
      "errori che ripete, poi gli altri in ordine di importanza. Ignora punteggiatura, " +
      "maiuscole e parole che sembrano solo errori di trascrizione. Per ogni correzione: " +
      "said, le parole sbagliate copiate esattamente da una battuta dello studente; " +
      "corrected, la forma corretta; italian, una sola riga in italiano che spiega la regola. " +
      "Nessun errore: corrections vuoto. Correggi solo lo studente, mai il personaggio. " +
      `memory: al massimo ${MAX_MEMORY_LINES} righe brevi in italiano su ciò che il personaggio ` +
      "sa ora dello studente, dai ricordi qui sotto aggiornati con questa conversazione: fatti " +
      "personali e cose successe tra loro, non errori di polacco. " +
      "Rispondi SOLO con JSON valido, senza testo attorno, nel formato: " +
      '{"corrections":[{"said":"...","corrected":"...","italian":"..."}],"memory":["..."]}\n\n' +
      `Personaggio: ${req.character}\n` +
      `Ricordi del personaggio sullo studente:\n${req.memory.map((m) => `- ${m}`).join("\n") || "(nessuno)"}\n\n` +
      `Conversazione:\n${lines.join("\n")}`
    );
  },
  parse: (text, req) => {
    const { corrections, memory } = parseJsonOutput(
      text,
      "debrief",
      z.object({ corrections: z.array(correction), memory: z.array(z.string().trim().min(1)) }),
    );
    const spoken = req.transcript.flatMap((l) =>
      l.speaker === "learner" ? [` ${normalized(l.text)} `] : [],
    );
    return {
      corrections: corrections.filter((c) =>
        spoken.some((l) => l.includes(` ${normalized(c.said)} `)),
      ),
      memory: memory.slice(0, MAX_MEMORY_LINES),
    };
  },
  // Corrects the learner's first line, if any, so dev shows a Debrief with one entry.
  stub: (req) => {
    const first = req.transcript.find((l) => l.speaker === "learner");
    const memory = [...req.memory, "Ricordo stub."].slice(-MAX_MEMORY_LINES);
    if (!first) return { corrections: [], memory };
    return {
      corrections: [{ said: first.text, corrected: first.text, italian: "Correzione stub." }],
      memory,
    };
  },
};

import { z } from "zod";
import type { CallSpec } from "#/llm/call";
import { parseJsonOutput, stripFences } from "#/llm/json";
import { MAX_TEXT_LEN } from "#/proofread/llm";

// Story premises and outline are Italian (UI copy); episodes are Polish at the
// learner's level. LLM ratios are unreliable: the story module checks the level via /analyze.

export interface StoryPremise {
  title: string;
  genre: string;
  hook: string; // one line
}

export interface StoryOutline {
  plot: string;
  characters: string[];
  beats: string[]; // one per episode: the count is the planned episode count
}

/** The level of a rejected draft: its share of content lemmas new to the learner, and which. */
export interface LevelFeedback {
  share: number;
  newWords: string[];
}

export interface EpisodeRequest {
  premise: StoryPremise;
  outline: StoryOutline;
  previous: string | null; // the episode before this one; the plan covers the earlier ones
  episodeNumber: number;
  totalEpisodes: number;
  newShare: number; // target share of new content lemmas
  feedback?: LevelFeedback; // set when redrafting
}

export const EPISODE_WORDS = "150-200";

/** A plan line without the "episodio N:" prefix older outlines carry. */
export function beatText(beat: string): string {
  return beat.replace(/^\s*episodio\s+\d+\s*:\s*/i, "");
}

const premiseSchema = z.object({
  title: z.string().trim().min(1).max(80),
  genre: z.string().trim().min(1).max(40),
  hook: z.string().trim().min(1).max(200),
});

/** Three story ideas, of genres the learner's past stories did not have. */
export const premises: CallSpec<string[], StoryPremise[]> = {
  name: "premises",
  tier: "story",
  prompt: (pastGenres) => {
    const avoid = pastGenres.length
      ? `Evita i generi delle storie già lette: ${pastGenres.join(", ")}. `
      : "";
    return (
      "Proponi 3 idee per una storia a puntate da leggere in polacco, per uno " +
      "studente italiano principiante, di 3 generi diversi tra loro. " +
      avoid +
      "Per ognuna: titolo, genere e un'unica frase di aggancio, tutto IN ITALIANO. " +
      "Rispondi SOLO con JSON valido, senza testo attorno, nel formato: " +
      '{"premises":[{"title":"...","genre":"...","hook":"..."}]}'
    );
  },
  parse: (text) =>
    parseJsonOutput(
      text,
      "premises",
      z.object({ premises: z.array(premiseSchema).min(3) }),
    ).premises.slice(0, 3),
  stub: () =>
    ["giallo", "avventura", "commedia"].map((genre, i) => ({
      title: `Storia stub ${i + 1}`,
      genre,
      hook: `Una storia ${genre} di prova.`,
    })),
};

/** The plot, characters and one beat per episode; the model picks the episode count. */
export const outline: CallSpec<StoryPremise, StoryOutline> = {
  name: "outline",
  tier: "story",
  prompt: (premise) =>
    "Pianifica una storia a puntate in polacco per uno studente italiano " +
    "principiante (sotto A1). Decidi tu il numero di episodi in base alla trama, " +
    "al massimo 10; ogni episodio sarà di " +
    `${EPISODE_WORDS} parole. Scrivi IN ITALIANO: ` +
    "la trama in breve, i personaggi (nome polacco + una descrizione breve) e, per " +
    "ogni episodio, in ordine, una frase su cosa succede. La storia deve arrivare a " +
    "una conclusione. Rispondi SOLO con JSON valido, senza testo attorno, nel formato: " +
    '{"plot":"...","characters":["..."],"beats":["...","..."]}\n\n' +
    `Titolo: ${premise.title}\nGenere: ${premise.genre}\nIdea: ${premise.hook}`,
  parse: (text) =>
    parseJsonOutput(
      text,
      "outline",
      z.object({
        plot: z.string().trim().min(1),
        characters: z.array(z.string().trim().min(1)),
        beats: z.array(z.string().trim().min(1)).min(1),
      }),
    ),
  stub: (premise) => ({
    plot: premise.hook,
    characters: ["Ala"],
    beats: ["inizio", "svolta", "fine"],
  }),
};

function levelFeedbackLine(req: EpisodeRequest): string {
  const f = req.feedback;
  if (!f) return "";
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const verdict =
    f.share > req.newShare
      ? "troppe: usa parole più comuni e frasi più semplici"
      : "troppo poche: introduci qualche parola meno comune";
  return (
    `\n\nLa bozza precedente aveva ${pct(f.share)} di parole nuove per lo studente, ` +
    `${verdict} (obiettivo ${pct(req.newShare)}). Parole nuove della bozza: ` +
    `${f.newWords.slice(0, 30).join(", ")}.`
  );
}

/** One Polish episode at the learner's level, following the outline. */
export const episode: CallSpec<EpisodeRequest, string> = {
  name: "episode",
  tier: "story",
  prompt: (req) => {
    const previous = req.previous
      ? `Episodio precedente (${req.episodeNumber - 1}):\n${req.previous}`
      : "Episodio precedente: nessuno, questo è il primo episodio.";
    return (
      `Scrivi l'episodio ${req.episodeNumber} di ${req.totalEpisodes} di una storia ` +
      "a puntate IN POLACCO per uno studente italiano principiante (sotto A1).\n\n" +
      `Lunghezza: ${EPISODE_WORDS} parole.\n` +
      "Lingua: polacco naturale, come lo scriverebbe un madrelingua; pensa in polacco. " +
      "Dove l'italiano usa 'avere' + sensazione, il polacco usa un'altra costruzione. " +
      "Per un desiderio usa un verbo, non solo l'oggetto desiderato. L'ordine delle " +
      "parole è quello naturale del polacco. Se le parole semplici non bastano a dirlo " +
      "in modo naturale, usa un'altra parola o riformula.\n" +
      "Ritmo: ogni frase porta un fatto nuovo, un'azione o una battuta di dialogo; la " +
      "struttura cambia di frase in frase, e le frasi si legano con congiunzioni.\n" +
      "Dialoghi: come nei libri polacchi, ogni battuta va a capo e inizia con un " +
      "trattino lungo (–), senza virgolette.\n" +
      "Livello: grammatica semplice e le parole più comuni del polacco; qualche parola " +
      "meno comune, chiara dal contesto.\n" +
      "Trama: segui il piano e resta coerente con l'episodio precedente. " +
      (req.episodeNumber === req.totalEpisodes
        ? "È l'ultimo episodio: concludi la storia.\n"
        : "\n") +
      "Rispondi SOLO con il testo polacco dell'episodio, senza titolo, traduzione né " +
      "commenti.\n\n" +
      `Titolo: ${req.premise.title}\nTrama: ${req.outline.plot}\n` +
      `Personaggi: ${req.outline.characters.join("; ")}\n` +
      `Piano degli episodi:\n${req.outline.beats.map((b, i) => `${i + 1}. ${beatText(b)}`).join("\n")}\n\n` +
      previous +
      levelFeedbackLine(req)
    );
  },
  parse: (reply) => {
    const text = stripFences(reply).trim();
    if (!text || text.length > MAX_TEXT_LEN) {
      throw new Error(`unexpected episode output: ${JSON.stringify(text.slice(0, 80))}`);
    }
    return text;
  },
  stub: (req) => `Ala ma kota. To jest odcinek ${req.episodeNumber}. Kot jest mały.`,
};

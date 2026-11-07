// Swappable gloss provider (backlog #6 / ADR-0002). Everything that needs an
// Italian gloss depends only on this interface; the concrete provider (stub
// now, Ollama or an API later) is chosen in getGlossProvider() (llm/index.ts).

import type { DebriefCorrection } from "#/db/schema";
import type { TranscriptLine } from "./conversation-session";
import { z } from "zod";

export type ProviderName = "stub" | "claude-cli" | "codex-cli" | "ollama" | "api" | "manual"; // learner-written gloss; not produced by a GlossProvider

/**
 * Which model tier a CLI call needs: stories are longer, level-controlled
 * Polish; a check reviews text a story-tier model wrote.
 */
export type LlmTask = "gloss" | "story" | "check" | "conversation";

export interface GlossRequest {
  lemma: string;
  pos: string;
  sentence: string; // the sentence the lemma appeared in, for disambiguation
}

// Shared prompt for the CLI providers (claude-cli, codex-cli). Kept here so the
// two providers can't drift. Hardened (2026-07): the model must gloss ONLY the
// lemma in dictionary form, using the sentence for sense disambiguation only:
// not translate the whole phrase or adjacent modifiers. Fixes the class of bug
// where "ciekawych rzeczy" made "rzecz" gloss as "cose interessanti".
export function buildGlossPrompt(req: GlossRequest): string {
  return (
    "Sei un dizionario polacco-italiano. Usa la frase SOLO come contesto per " +
    "scegliere il senso giusto. Fornisci la glossa italiana del SOLO lemma " +
    "indicato, nella sua forma base di dizionario. NON tradurre la frase " +
    "intera né le parole vicine (aggettivi, articoli): glossa solo il lemma. " +
    "Rispondi SOLO con la glossa italiana (1-4 parole), senza ripetere la " +
    "parola polacca, senza frecce, spiegazioni né punteggiatura finale.\n\n" +
    `Lemma: ${req.lemma}\nPOS: ${req.pos}\nFrase: ${req.sentence}`
  );
}

const MAX_GLOSS_LEN = 60;

function stripFences(stdout: string): string {
  return stdout
    .trim()
    .replace(/^```(?:json|text)?\s*/i, "")
    .replace(/\s*```$/, "");
}

function parseJsonOutput<T>(stdout: string, what: string, schema: z.ZodType<T>): T {
  const raw = stripFences(stdout);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${what} output is not JSON: ${JSON.stringify(raw.slice(0, 120))}`);
  }
  return schema.parse(json);
}

// Validate the raw CLI output. Throws on junk so getGloss() bubbles and nothing
// is cached: a bad gloss written to the cache becomes permanent (#6). The model
// sometimes echoes the sentence's surface form as "swoich → proprio", so only
// the text after the last arrow is the gloss.
export function parseGloss(stdout: string): string {
  const out = stdout.trim().replace(/^.*(?:→|->|=>)\s*/, "");
  if (!out || out.length > MAX_GLOSS_LEN) {
    throw new Error(`unexpected gloss output: ${JSON.stringify(out.slice(0, 80))}`);
  }
  return out;
}

// --- Per-sense glossing (ADR-0002, kaikki home dictionary) ------------------
// Hybrid strategy: ONE call translates ALL Wiktionary senses of a lemma AND
// flags which sense the given sentence uses. Cost stays 1 call/lemma.

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

// Shared prompt for the CLI providers, same hardened tone as buildGlossPrompt.
export function buildSenseGlossPrompt(req: SenseGlossRequest): string {
  return (
    "Sei un dizionario polacco-italiano. Il lemma polacco ha i seguenti sensi " +
    "(dal Wiktionary inglese). Traduci OGNI senso in una glossa italiana breve " +
    "(1-4 parole, forma base di dizionario). Poi indica in bestIndex il senso più " +
    "vicino a quello usato nella frase data. " +
    OCCURRENCE_RULE +
    " Rispondi SOLO con JSON valido, senza testo attorno, nel formato: " +
    '{"translations":[{"index":0,"italian":"..."}],"bestIndex":0,"occurrence":{"index":0}}\n\n' +
    `Lemma: ${req.lemma}\nPOS: ${req.pos}\nForma: ${req.surface}\nFrase: ${req.sentence}\nSensi:\n` +
    req.senses.map((s) => `${s.index}. ${s.gloss}`).join("\n")
  );
}

export function buildOccurrencePrompt(req: OccurrenceRequest): string {
  return (
    "Sei un dizionario polacco-italiano. Ecco i sensi del lemma polacco (inglese, " +
    "con la glossa italiana). " +
    OCCURRENCE_RULE +
    " Rispondi SOLO con JSON valido, senza testo attorno.\n\n" +
    `Lemma: ${req.lemma}\nPOS: ${req.pos}\nForma: ${req.surface}\nFrase: ${req.sentence}\nSensi:\n` +
    (req.senses.map((s) => `${s.index}. ${s.gloss} (${s.italian})`).join("\n") || "(nessuno)")
  );
}

const occurrenceResponse = z.union([
  z.object({ index: z.number().int().min(0) }),
  z.object({
    italian: z.string().trim().min(1).max(60),
    fixed: z.boolean(),
    note: z.string().trim().min(1).max(60).nullable(),
  }),
]);

const senseGlossResponse = z.object({
  translations: z
    .array(
      z.object({
        index: z.number().int().min(0),
        italian: z.string().trim().min(1).max(60),
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

// Validate the raw CLI output. Throws on junk so nothing gets cached: a bad
// gloss written to the cache becomes permanent (#6).
export function parseSenseGlossJson(stdout: string, senseCount: number): SenseGlossResult {
  const parsed = parseJsonOutput(stdout, "sense gloss", senseGlossResponse);
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
}

export function parseOccurrenceJson(stdout: string, senseCount: number): OccurrenceResult {
  return checkOccurrence(parseJsonOutput(stdout, "occurrence", occurrenceResponse), senseCount);
}

// --- MWE and Formula check (CONTEXT.md "Multi-word expression", "Formula") ---
// ONE call per batch: a dictionary match can be a compositional phrase
// (*To jest chleb*) or a verb (*Proszę o chleb*), so each is judged in its sentence.

export interface MweCheckItem {
  headword: string;
  meaning: string; // English dictionary senses of the MWE or interjection
  sentence: string;
}

export function buildMweCheckPrompt(items: MweCheckItem[]): string {
  return (
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
      .join("\n\n")
  );
}

export function parseMweCheckJson(stdout: string, itemCount: number): boolean[] {
  const { keep } = parseJsonOutput(stdout, "MWE check", z.object({ keep: z.array(z.boolean()) }));
  if (keep.length !== itemCount) {
    throw new Error(`MWE check returned ${keep.length} verdicts for ${itemCount} items`);
  }
  return keep;
}

// --- Comprehension checks (roadmap 2026-07-12) ------------------------------
// ONE call generates all MCQ questions for a text. Italian questions/choices
// isolate text comprehension from question comprehension at sub-A1.

export interface ComprehensionRequest {
  text: string; // full text content
}

/** An Italian multiple-choice question: comprehension checks and Passage exercises. */
export interface ChoiceQuestion {
  question: string;
  choices: string[]; // 3–4 Italian choices
  correctIndex: number;
}

export interface ComprehensionResult {
  questions: ChoiceQuestion[]; // 1–10, LLM picks the count
}

// Shared prompt for the CLI providers, same hardened tone as the gloss prompts.
// The model picks the question count (1–10) proportional to text length: no
// server-side length math.
export function buildComprehensionPrompt(req: ComprehensionRequest): string {
  return (
    "Sei un insegnante di polacco. Verifica se uno studente italiano ha capito " +
    "il testo polacco qui sotto. Scrivi domande a scelta multipla IN ITALIANO " +
    "sul contenuto del testo. Scegli tu tra 1 e 10 domande in proporzione alla " +
    "lunghezza del testo (testo brevissimo ≈ 1-2, testo lungo massimo 10). " +
    "Ogni domanda ha 3 o 4 risposte in italiano, di cui ESATTAMENTE una " +
    "corretta secondo il testo; i distrattori devono essere plausibili ma " +
    "chiaramente sbagliati. Rispondi SOLO con JSON valido, senza testo attorno, " +
    'nel formato: {"questions":[{"question":"...","choices":["...","...","..."],"correctIndex":0}]}\n\n' +
    `Testo:\n${req.text}`
  );
}

const comprehensionResponse = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().trim().min(1),
        choices: z.array(z.string().trim().min(1)).min(3).max(4),
        correctIndex: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(10),
});

// Validate the raw CLI output. Throws on junk so nothing gets cached: the
// service writes all questions in one transaction only after this passes.
export function parseComprehensionJson(stdout: string): ComprehensionResult {
  const parsed = parseJsonOutput(stdout, "comprehension", comprehensionResponse);
  for (const q of parsed.questions) {
    if (q.correctIndex >= q.choices.length) {
      throw new Error(
        `comprehension correctIndex ${q.correctIndex} out of range (${q.choices.length} choices)`,
      );
    }
  }
  return parsed;
}

// Story premises and outline are Italian (UI copy); episodes are Polish at the
// learner's level. LLM ratios are unreliable: the story service checks the level via /analyze.

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

export function buildPremisesPrompt(pastGenres: string[]): string {
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
}

const premiseSchema = z.object({
  title: z.string().trim().min(1).max(80),
  genre: z.string().trim().min(1).max(40),
  hook: z.string().trim().min(1).max(200),
});

export function parsePremisesJson(stdout: string): StoryPremise[] {
  return parseJsonOutput(
    stdout,
    "premises",
    z.object({ premises: z.array(premiseSchema).min(3) }),
  ).premises.slice(0, 3);
}

export function buildStoryOutlinePrompt(premise: StoryPremise): string {
  return (
    "Pianifica una storia a puntate in polacco per uno studente italiano " +
    "principiante (sotto A1). Decidi tu il numero di episodi in base alla trama, " +
    "al massimo 10; ogni episodio sarà di " +
    `${EPISODE_WORDS} parole. Scrivi IN ITALIANO: ` +
    "la trama in breve, i personaggi (nome polacco + una descrizione breve) e, per " +
    "ogni episodio, in ordine, una frase su cosa succede. La storia deve arrivare a " +
    "una conclusione. Rispondi SOLO con JSON valido, senza testo attorno, nel formato: " +
    '{"plot":"...","characters":["..."],"beats":["...","..."]}\n\n' +
    `Titolo: ${premise.title}\nGenere: ${premise.genre}\nIdea: ${premise.hook}`
  );
}

/** A plan line without the "episodio N:" prefix older outlines carry. */
export function beatText(beat: string): string {
  return beat.replace(/^\s*episodio\s+\d+\s*:\s*/i, "");
}

export function parseStoryOutlineJson(stdout: string): StoryOutline {
  return parseJsonOutput(
    stdout,
    "outline",
    z.object({
      plot: z.string().trim().min(1),
      characters: z.array(z.string().trim().min(1)),
      beats: z.array(z.string().trim().min(1)).min(1),
    }),
  );
}

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

export function buildEpisodePrompt(req: EpisodeRequest): string {
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
}

const MAX_EPISODE_LEN = 4000;

export function parseEpisodeText(stdout: string): string {
  const text = stripFences(stdout).trim();
  if (!text || text.length > MAX_EPISODE_LEN) {
    throw new Error(`unexpected episode output: ${JSON.stringify(text.slice(0, 80))}`);
  }
  return text;
}

export interface PassageQuestionRequest {
  passage: string;
  lemma: string;
  target: string;
}

export function buildPassageQuestionPrompt(req: PassageQuestionRequest): string {
  return (
    "Sei un insegnante di polacco. Ecco un breve testo polacco per uno studente " +
    "italiano principiante. Scrivi UNA domanda a scelta multipla IN ITALIANO a cui " +
    `si può rispondere solo capendo la parola «${req.target}» (lemma: ${req.lemma}) ` +
    "in questo contesto. Non tradurre né citare quella parola nella domanda. 3 o 4 " +
    "risposte in italiano, tutte diverse, di cui ESATTAMENTE una corretta secondo il " +
    "testo. Rispondi SOLO con JSON valido, senza testo attorno, nel formato: " +
    '{"question":"...","choices":["...","...","..."],"correctIndex":0}\n\n' +
    `Testo:\n${req.passage}`
  );
}

export function parsePassageQuestionJson(stdout: string): ChoiceQuestion {
  const q = parseJsonOutput(
    stdout,
    "passage question",
    z.object({
      question: z.string().trim().min(1),
      choices: z.array(z.string().trim().min(1)).min(3).max(4),
      correctIndex: z.number().int().min(0),
    }),
  );
  if (q.correctIndex >= q.choices.length) {
    throw new Error(`passage correctIndex ${q.correctIndex} out of range`);
  }
  if (new Set(q.choices).size !== q.choices.length) {
    throw new Error("passage question has duplicate choices");
  }
  return q;
}

// Proofread and Correction (CONTEXT.md) are calls of their own: a model
// reviewing its draft in the drafting call keeps its own mistakes.

/** A flagged span: its exact text in the proofread text, and why. */
export interface ProofreadFlag {
  span: string;
  reason: string;
}

export function buildProofreadPrompt(text: string): string {
  return (
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
    `Testo:\n${text}`
  );
}

export function parseProofreadJson(stdout: string, text: string): ProofreadFlag[] {
  const { errors } = parseJsonOutput(
    stdout,
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
}

export function buildCorrectionPrompt(text: string, flags: ProofreadFlag[]): string {
  return (
    "Sei un correttore di bozze madrelingua polacco. Il testo polacco qui sotto ha gli " +
    "errori elencati. Correggi SOLO quelli, con la modifica più piccola che rende la " +
    "frase corretta e ne conserva il significato, insieme alle parole che concordano " +
    "con le parti corrette (aggettivi, verbi, pronomi), anche nel resto del testo. Una " +
    "parola che non esiste in polacco va sostituita con la parola polacca giusta. Lo " +
    "stesso errore, dove si ripete nel testo, va corretto anche lì. Non " +
    "cambiare nient'altro: stessa storia, stesse frasi, stessa punteggiatura e a capo. " +
    "Rispondi SOLO con il testo corretto, senza commenti.\n\n" +
    `Errori:\n${flags.map((f) => `- «${f.span}»: ${f.reason}`).join("\n")}\n\n` +
    `Testo:\n${text}`
  );
}

export function parseCorrectedText(stdout: string): string {
  const text = stripFences(stdout).trim();
  if (!text || text.length > MAX_EPISODE_LEN) {
    throw new Error(`unexpected correction output: ${JSON.stringify(text.slice(0, 80))}`);
  }
  return text;
}

// --- Report review (CONTEXT.md "Report review") ------------------------------
// ONE call per batch. The model picks a numbered dictionary sense whose Italian
// already exists; free Italian is for when none fits (AGENTS.md deterministic first).

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

export function buildReportReviewPrompt(items: ReportReviewItem[]): string {
  return (
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
    items.map((it, i) => reportItemText(it, i + 1)).join("\n\n")
  );
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

/** A malformed item is null: it stays pending while the others apply. */
export function parseReportReviewJson(stdout: string, itemCount: number): (ReportVerdict | null)[] {
  const { reviews } = parseJsonOutput(
    stdout,
    "report review",
    z.object({ reviews: z.array(z.unknown()) }),
  );
  if (reviews.length !== itemCount) {
    throw new Error(`report review returned ${reviews.length} verdicts for ${itemCount} items`);
  }
  return reviews.map((r) => reportVerdict.safeParse(r).data ?? null);
}

// --- Scene preparation (CONTEXT.md "Conversation", "Goal") ------------------
// ONE story-tier call per scene, outside the turn loop. The model picks a character and
// voices by key, checked here against the outline and the catalog; Goal step ids are not its job.

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

export function buildScenePrompt(req: SceneRequest): string {
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

export function parseSceneJson(stdout: string, req: SceneRequest): SceneResult {
  const scene = parseJsonOutput(stdout, "scene", sceneResponse);
  if (scene.character >= req.characters.length) {
    throw new Error(`scene character ${scene.character} out of range (${req.characters.length})`);
  }
  if (!req.voices) return { ...scene, voices: null };
  const ids = new Set(req.voices.map((v) => v.id));
  if (scene.voices?.length !== req.characters.length || !scene.voices.every((v) => ids.has(v))) {
    throw new Error(`scene voices ${JSON.stringify(scene.voices)} do not match the catalog`);
  }
  return scene;
}

// --- Debrief (CONTEXT.md "Debrief") ---------------------------------------
// ONE call when the scene ends. A correction quotes the learner's own words, checked here
// against what they said, so the Debrief never corrects a sentence nobody spoke.

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

export function buildDebriefPrompt(req: DebriefRequest): string {
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

export function parseDebriefJson(stdout: string, learnerLines: string[]): DebriefResult {
  const { corrections, memory } = parseJsonOutput(
    stdout,
    "debrief",
    z.object({ corrections: z.array(correction), memory: z.array(z.string().trim().min(1)) }),
  );
  const spoken = learnerLines.map((l) => ` ${normalized(l)} `);
  return {
    corrections: corrections.filter((c) =>
      spoken.some((l) => l.includes(` ${normalized(c.said)} `)),
    ),
    memory: memory.slice(0, MAX_MEMORY_LINES),
  };
}

/** Optional capabilities: providers without them fail any generated Polish text. */
export interface Proofreader {
  proofread?(text: string): Promise<ProofreadFlag[]>;
  correct?(text: string, flags: ProofreadFlag[]): Promise<string>;
}

export interface GlossProvider extends Proofreader {
  readonly name: ProviderName; // recorded on the cache row so output can be purged
  gloss(req: GlossRequest): Promise<string>;
  // Optional capability: providers without it fall back to sentence-context
  // glossing even for in-dictionary lemmas.
  glossSenses?(req: SenseGlossRequest): Promise<SenseGlossResult>;
  // Optional capability: the occurrence gloss of a lemma already glossed.
  // Providers without it show the lemma gloss for later occurrences.
  glossOccurrence?(req: OccurrenceRequest): Promise<OccurrenceResult>;
  // Optional capability: comprehension-check MCQ generation for a whole text.
  comprehension?(req: ComprehensionRequest): Promise<ComprehensionResult>;
  // Optional capability: Passage exercise preparation, run in the background.
  passageQuestion?(req: PassageQuestionRequest): Promise<ChoiceQuestion>;
  // Optional capability: providers without it fail any import with an MWE
  // match or a Formula candidate.
  checkMwes?(items: MweCheckItem[]): Promise<boolean[]>;
  // Optional capability: providers without it leave every Report pending.
  reviewReports?(items: ReportReviewItem[]): Promise<(ReportVerdict | null)[]>;
}

export interface StoryProvider extends Proofreader {
  readonly name: ProviderName;
  premises(pastGenres: string[]): Promise<StoryPremise[]>;
  outline(premise: StoryPremise): Promise<StoryOutline>;
  episode(req: EpisodeRequest): Promise<string>;
}

export interface SceneProvider {
  scene(req: SceneRequest): Promise<SceneResult>;
  debrief(req: DebriefRequest, conversationId: number): Promise<DebriefResult>;
}

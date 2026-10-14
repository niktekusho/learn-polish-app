// Swappable gloss provider (backlog #6 / ADR-0002). Everything that needs an
// Italian gloss depends only on this interface; the concrete provider (stub
// now, Ollama or an API later) is chosen in getGlossProvider().

import { z } from "zod";
import { wordPattern } from "#/reader/word-pattern";

export type ProviderName = "stub" | "claude-cli" | "codex-cli" | "ollama" | "api" | "manual"; // learner-written gloss; not produced by a GlossProvider

export interface GlossRequest {
  lemma: string;
  pos: string;
  sentence: string; // the sentence the lemma appeared in, for disambiguation
}

// Shared prompt for the CLI providers (claude-cli, codex-cli). Kept here so the
// two providers can't drift. Hardened (2026-07): the model must gloss ONLY the
// lemma in dictionary form, using the sentence for sense disambiguation only —
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
  sentence: string;
  senses: { index: number; gloss: string }[]; // English Wiktionary senses
}

export interface SenseGlossResult {
  translations: { index: number; italian: string }[]; // ALL senses translated
  bestIndex: number; // sense fitting the sentence
}

// Shared prompt for the CLI providers, same hardened tone as buildGlossPrompt.
export function buildSenseGlossPrompt(req: SenseGlossRequest): string {
  return (
    "Sei un dizionario polacco-italiano. Il lemma polacco ha i seguenti sensi " +
    "(dal Wiktionary inglese). Traduci OGNI senso in una glossa italiana breve " +
    "(1-4 parole, forma base di dizionario). Poi indica quale senso è quello " +
    "usato nella frase data. Rispondi SOLO con JSON valido, senza testo attorno, " +
    'nel formato: {"translations":[{"index":0,"italian":"..."}],"bestIndex":0}\n\n' +
    `Lemma: ${req.lemma}\nPOS: ${req.pos}\nFrase: ${req.sentence}\nSensi:\n` +
    req.senses.map((s) => `${s.index}. ${s.gloss}`).join("\n")
  );
}

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
});

// Validate the raw CLI output. Throws on junk so nothing gets cached — a bad
// gloss written to the cache becomes permanent (#6).
export function parseSenseGlossJson(stdout: string, senseCount: number): SenseGlossResult {
  const raw = stdout
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`sense gloss output is not JSON: ${JSON.stringify(raw.slice(0, 120))}`);
  }
  const parsed = senseGlossResponse.parse(json);
  for (const t of parsed.translations) {
    if (t.index >= senseCount) {
      throw new Error(`sense gloss translation index ${t.index} out of range (${senseCount})`);
    }
  }
  if (!parsed.translations.some((t) => t.index === parsed.bestIndex)) {
    throw new Error(`bestIndex ${parsed.bestIndex} not among translations`);
  }
  return parsed;
}

// --- Comprehension checks (roadmap 2026-07-12) ------------------------------
// ONE call generates all MCQ questions for a text. Italian questions/choices
// isolate text comprehension from question comprehension at sub-A1.

export interface ComprehensionRequest {
  text: string; // full text content
}

export interface ComprehensionQuestion {
  question: string;
  choices: string[]; // 3–4 Italian choices
  correctIndex: number;
}

export interface ComprehensionResult {
  questions: ComprehensionQuestion[]; // 1–10, LLM picks the count
}

// Shared prompt for the CLI providers, same hardened tone as the gloss prompts.
// The model picks the question count (1–10) proportional to text length — no
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

// Validate the raw CLI output. Throws on junk so nothing gets cached — the
// service writes all questions in one transaction only after this passes.
export function parseComprehensionJson(stdout: string): ComprehensionResult {
  const raw = stdout
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`comprehension output is not JSON: ${JSON.stringify(raw.slice(0, 120))}`);
  }
  const parsed = comprehensionResponse.parse(json);
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

export interface EpisodeRequest {
  premise: StoryPremise;
  outline: StoryOutline;
  previous: string[]; // earlier episode texts, in order
  episodeNumber: number;
  totalEpisodes: number;
  knownLemmas: string[];
}

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

export function buildPremisesPrompt(): string {
  return (
    "Proponi 3 idee per una storia a puntate da leggere in polacco, per uno " +
    "studente italiano principiante. Generi diversi tra loro (giallo, avventura, " +
    "commedia, fantasy, quotidiano...). Per ognuna: titolo, genere e un'unica " +
    "frase di aggancio, tutto IN ITALIANO. Rispondi SOLO con JSON valido, senza " +
    'testo attorno, nel formato: {"premises":[{"title":"...","genre":"...","hook":"..."}]}'
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
    "al massimo 10; ogni episodio sarà di circa 150 parole. Scrivi IN ITALIANO: " +
    "la trama in breve, i personaggi (nome polacco + una descrizione breve) e, per " +
    "ogni episodio, cosa succede. La storia deve arrivare a una conclusione. " +
    "Rispondi SOLO con JSON valido, senza testo attorno, nel formato: " +
    '{"plot":"...","characters":["..."],"beats":["episodio 1: ...","episodio 2: ..."]}\n\n' +
    `Titolo: ${premise.title}\nGenere: ${premise.genre}\nIdea: ${premise.hook}`
  );
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

export function buildEpisodePrompt(req: EpisodeRequest): string {
  const previous = req.previous.length
    ? req.previous.map((t, i) => `--- Episodio ${i + 1} ---\n${t}`).join("\n\n")
    : "(nessuno: questo è il primo episodio)";
  return (
    `Scrivi l'episodio ${req.episodeNumber} di ${req.totalEpisodes} di una storia ` +
    "a puntate IN POLACCO per uno studente italiano principiante (sotto A1). " +
    "Circa 150 parole. Grammatica semplice: frasi brevi, presente quando possibile. " +
    "Usa soprattutto le parole che lo studente conosce (elenco sotto, in forma base; " +
    "puoi fletterle), e circa il 10% di parole nuove. Segui il piano della storia e " +
    "resta coerente con gli episodi precedenti. " +
    (req.episodeNumber === req.totalEpisodes ? "È l'ultimo episodio: concludi la storia. " : "") +
    "Rispondi SOLO con il testo polacco dell'episodio, senza titolo, traduzione né " +
    "commenti.\n\n" +
    `Titolo: ${req.premise.title}\nTrama: ${req.outline.plot}\n` +
    `Personaggi: ${req.outline.characters.join("; ")}\n` +
    `Piano degli episodi:\n${req.outline.beats.map((b, i) => `${i + 1}. ${b}`).join("\n")}\n\n` +
    `Episodi precedenti:\n${previous}\n\n` +
    `Parole conosciute: ${req.knownLemmas.join(", ")}`
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

export interface PassageRequest {
  lemma: string;
  pos: string;
  knownLemmas: string[];
}

export interface GeneratedPassage {
  passage: string;
  target: string;
}

export interface PassageQuestionRequest {
  passage: string;
  lemma: string;
  target: string;
}

export function buildPassagePrompt(req: PassageRequest): string {
  return (
    "Scrivi 2 o 3 frasi brevi IN POLACCO per uno studente italiano principiante " +
    "(sotto A1) che contengono la parola indicata, usata in modo che il suo " +
    "significato sia chiaro dal contesto. Usa soprattutto le parole conosciute " +
    "(elenco sotto, in forma base; puoi fletterle). Rispondi SOLO con JSON valido, " +
    'senza testo attorno, nel formato: {"passage":"...","target":"..."} dove ' +
    "target è la parola esattamente come appare nel testo.\n\n" +
    `Parola: ${req.lemma}\nPOS: ${req.pos}\nParole conosciute: ${req.knownLemmas.join(", ")}`
  );
}

export function parsePassageJson(stdout: string): GeneratedPassage {
  const res = parseJsonOutput(
    stdout,
    "passage",
    z.object({
      passage: z.string().trim().min(1).max(600),
      target: z.string().trim().min(1),
    }),
  );
  if (!wordPattern(res.target).test(res.passage)) {
    throw new Error(`passage target ${JSON.stringify(res.target)} not in passage`);
  }
  return res;
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

export function parsePassageQuestionJson(stdout: string): ComprehensionQuestion {
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

export interface GlossProvider {
  readonly name: ProviderName; // recorded on the cache row so output can be purged
  gloss(req: GlossRequest): Promise<string>;
  // Optional capability: providers without it fall back to sentence-context
  // glossing even for in-dictionary lemmas.
  glossSenses?(req: SenseGlossRequest): Promise<SenseGlossResult>;
  // Optional capability: comprehension-check MCQ generation for a whole text.
  comprehension?(req: ComprehensionRequest): Promise<ComprehensionResult>;
  // Optional capabilities: story generation.
  storyPremises?(): Promise<StoryPremise[]>;
  storyOutline?(premise: StoryPremise): Promise<StoryOutline>;
  storyEpisode?(req: EpisodeRequest): Promise<string>;
  // Optional capabilities: Passage exercise preparation, run in the background.
  passage?(req: PassageRequest): Promise<GeneratedPassage>;
  passageQuestion?(req: PassageQuestionRequest): Promise<ComprehensionQuestion>;
}

import { ClaudeCliGlossProvider } from "./claude-cli";
import { CodexCliGlossProvider } from "./codex-cli";
import { StubGlossProvider } from "./stub";

let cached: GlossProvider | null = null;

// GLOSS_PROVIDER selects the concrete provider; default stub keeps tests and
// offline dev untouched. Set GLOSS_PROVIDER=claude-cli or codex-cli to use a
// real CLI.
export function getGlossProvider(): GlossProvider {
  if (!cached) {
    switch (process.env.GLOSS_PROVIDER) {
      case "claude-cli":
        cached = new ClaudeCliGlossProvider();
        break;
      case "codex-cli":
        cached = new CodexCliGlossProvider();
        break;
      default:
        cached = new StubGlossProvider();
    }
  }
  return cached;
}

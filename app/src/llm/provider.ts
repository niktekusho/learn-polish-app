// Swappable gloss provider (backlog #6 / ADR-0002). Everything that needs an
// Italian gloss depends only on this interface; the concrete provider (stub
// now, Ollama or an API later) is chosen in getGlossProvider().

import { z } from 'zod'

export type ProviderName =
  | 'stub'
  | 'claude-cli'
  | 'codex-cli'
  | 'ollama'
  | 'api'
  | 'manual' // learner-written gloss; not produced by a GlossProvider

export interface GlossRequest {
  lemma: string
  pos: string
  sentence: string // the sentence the lemma appeared in, for disambiguation
}

// Shared prompt for the CLI providers (claude-cli, codex-cli). Kept here so the
// two providers can't drift. Hardened (2026-07): the model must gloss ONLY the
// lemma in dictionary form, using the sentence for sense disambiguation only —
// not translate the whole phrase or adjacent modifiers. Fixes the class of bug
// where "ciekawych rzeczy" made "rzecz" gloss as "cose interessanti".
export function buildGlossPrompt(req: GlossRequest): string {
  return (
    'Sei un dizionario polacco-italiano. Usa la frase SOLO come contesto per ' +
    'scegliere il senso giusto. Fornisci la glossa italiana del SOLO lemma ' +
    'indicato, nella sua forma base di dizionario. NON tradurre la frase ' +
    "intera né le parole vicine (aggettivi, articoli): glossa solo il lemma. " +
    'Rispondi SOLO con la glossa (1-4 parole), senza spiegazioni né ' +
    'punteggiatura finale.\n\n' +
    `Lemma: ${req.lemma}\nPOS: ${req.pos}\nFrase: ${req.sentence}`
  )
}

// --- Per-sense glossing (ADR-0002, kaikki home dictionary) ------------------
// Hybrid strategy: ONE call translates ALL Wiktionary senses of a lemma AND
// flags which sense the given sentence uses. Cost stays 1 call/lemma.

export interface SenseGlossRequest {
  lemma: string
  pos: string
  sentence: string
  senses: { index: number; gloss: string }[] // English Wiktionary senses
}

export interface SenseGlossResult {
  translations: { index: number; italian: string }[] // ALL senses translated
  bestIndex: number // sense fitting the sentence
}

// Shared prompt for the CLI providers, same hardened tone as buildGlossPrompt.
export function buildSenseGlossPrompt(req: SenseGlossRequest): string {
  return (
    'Sei un dizionario polacco-italiano. Il lemma polacco ha i seguenti sensi ' +
    '(dal Wiktionary inglese). Traduci OGNI senso in una glossa italiana breve ' +
    '(1-4 parole, forma base di dizionario). Poi indica quale senso è quello ' +
    'usato nella frase data. Rispondi SOLO con JSON valido, senza testo attorno, ' +
    'nel formato: {"translations":[{"index":0,"italian":"..."}],"bestIndex":0}\n\n' +
    `Lemma: ${req.lemma}\nPOS: ${req.pos}\nFrase: ${req.sentence}\nSensi:\n` +
    req.senses.map((s) => `${s.index}. ${s.gloss}`).join('\n')
  )
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
})

// Validate the raw CLI output. Throws on junk so nothing gets cached — a bad
// gloss written to the cache becomes permanent (#6).
export function parseSenseGlossJson(
  stdout: string,
  senseCount: number,
): SenseGlossResult {
  const raw = stdout
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(`sense gloss output is not JSON: ${JSON.stringify(raw.slice(0, 120))}`)
  }
  const parsed = senseGlossResponse.parse(json)
  for (const t of parsed.translations) {
    if (t.index >= senseCount) {
      throw new Error(`sense gloss translation index ${t.index} out of range (${senseCount})`)
    }
  }
  if (!parsed.translations.some((t) => t.index === parsed.bestIndex)) {
    throw new Error(`bestIndex ${parsed.bestIndex} not among translations`)
  }
  return parsed
}

// --- Comprehension checks (roadmap 2026-07-12) ------------------------------
// ONE call generates all MCQ questions for a text. Italian questions/choices
// isolate text comprehension from question comprehension at sub-A1.

export interface ComprehensionRequest {
  text: string // full text content
}

export interface ComprehensionQuestion {
  question: string
  choices: string[] // 3–4 Italian choices
  correctIndex: number
}

export interface ComprehensionResult {
  questions: ComprehensionQuestion[] // 1–10, LLM picks the count
}

// Shared prompt for the CLI providers, same hardened tone as the gloss prompts.
// The model picks the question count (1–10) proportional to text length — no
// server-side length math.
export function buildComprehensionPrompt(req: ComprehensionRequest): string {
  return (
    'Sei un insegnante di polacco. Verifica se uno studente italiano ha capito ' +
    'il testo polacco qui sotto. Scrivi domande a scelta multipla IN ITALIANO ' +
    'sul contenuto del testo. Scegli tu tra 1 e 10 domande in proporzione alla ' +
    'lunghezza del testo (testo brevissimo ≈ 1-2, testo lungo massimo 10). ' +
    'Ogni domanda ha 3 o 4 risposte in italiano, di cui ESATTAMENTE una ' +
    'corretta secondo il testo; i distrattori devono essere plausibili ma ' +
    'chiaramente sbagliati. Rispondi SOLO con JSON valido, senza testo attorno, ' +
    'nel formato: {"questions":[{"question":"...","choices":["...","...","..."],"correctIndex":0}]}\n\n' +
    `Testo:\n${req.text}`
  )
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
})

// Validate the raw CLI output. Throws on junk so nothing gets cached — the
// service writes all questions in one transaction only after this passes.
export function parseComprehensionJson(stdout: string): ComprehensionResult {
  const raw = stdout
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(
      `comprehension output is not JSON: ${JSON.stringify(raw.slice(0, 120))}`,
    )
  }
  const parsed = comprehensionResponse.parse(json)
  for (const q of parsed.questions) {
    if (q.correctIndex >= q.choices.length) {
      throw new Error(
        `comprehension correctIndex ${q.correctIndex} out of range (${q.choices.length} choices)`,
      )
    }
  }
  return parsed
}

export interface GlossProvider {
  readonly name: ProviderName // recorded on the cache row so output can be purged
  gloss(req: GlossRequest): Promise<string>
  // Optional capability: providers without it fall back to sentence-context
  // glossing even for in-dictionary lemmas.
  glossSenses?(req: SenseGlossRequest): Promise<SenseGlossResult>
  // Optional capability: comprehension-check MCQ generation for a whole text.
  comprehension?(req: ComprehensionRequest): Promise<ComprehensionResult>
}

import { ClaudeCliGlossProvider } from './claude-cli'
import { CodexCliGlossProvider } from './codex-cli'
import { StubGlossProvider } from './stub'

let cached: GlossProvider | null = null

// GLOSS_PROVIDER selects the concrete provider; default stub keeps tests and
// offline dev untouched. Set GLOSS_PROVIDER=claude-cli or codex-cli to use a
// real CLI.
export function getGlossProvider(): GlossProvider {
  if (!cached) {
    switch (process.env.GLOSS_PROVIDER) {
      case 'claude-cli':
        cached = new ClaudeCliGlossProvider()
        break
      case 'codex-cli':
        cached = new CodexCliGlossProvider()
        break
      default:
        cached = new StubGlossProvider()
    }
  }
  return cached
}

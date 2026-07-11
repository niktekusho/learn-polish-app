// Swappable gloss provider (backlog #6 / ADR-0002). Everything that needs an
// Italian gloss depends only on this interface; the concrete provider (stub
// now, Ollama or an API later) is chosen in getGlossProvider().

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

export interface GlossProvider {
  readonly name: ProviderName // recorded on the cache row so output can be purged
  gloss(req: GlossRequest): Promise<string>
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

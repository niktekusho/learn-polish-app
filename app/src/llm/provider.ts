// Swappable gloss provider (backlog #6 / ADR-0002). Everything that needs an
// Italian gloss depends only on this interface; the concrete provider (stub
// now, Ollama or an API later) is chosen in getGlossProvider().

export type ProviderName = 'stub' | 'claude-cli' | 'ollama' | 'api'

export interface GlossRequest {
  lemma: string
  pos: string
  sentence: string // the sentence the lemma appeared in, for disambiguation
}

export interface GlossProvider {
  readonly name: ProviderName // recorded on the cache row so output can be purged
  gloss(req: GlossRequest): Promise<string>
}

import { ClaudeCliGlossProvider } from './claude-cli'
import { StubGlossProvider } from './stub'

let cached: GlossProvider | null = null

// GLOSS_PROVIDER selects the concrete provider; default stub keeps tests and
// offline dev untouched. Set GLOSS_PROVIDER=claude-cli to use the real CLI.
export function getGlossProvider(): GlossProvider {
  if (!cached) {
    cached =
      process.env.GLOSS_PROVIDER === 'claude-cli'
        ? new ClaudeCliGlossProvider()
        : new StubGlossProvider()
  }
  return cached
}

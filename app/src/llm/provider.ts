// Swappable gloss provider (backlog #6 / ADR-0002). Everything that needs an
// Italian gloss depends only on this interface; the concrete provider (stub
// now, Ollama or an API later) is chosen in getGlossProvider().

export type ProviderName = 'stub' | 'ollama' | 'api'

export interface GlossRequest {
  lemma: string
  pos: string
  sentence: string // the sentence the lemma appeared in, for disambiguation
}

export interface GlossProvider {
  readonly name: ProviderName // recorded on the cache row so output can be purged
  gloss(req: GlossRequest): Promise<string>
}

import { StubGlossProvider } from './stub'

let cached: GlossProvider | null = null

export function getGlossProvider(): GlossProvider {
  // ponytail: stub only for now. When a real provider lands, switch on an
  // LLM_PROVIDER env var here — callers never change.
  if (!cached) cached = new StubGlossProvider()
  return cached
}

import type {
  GlossProvider,
  GlossRequest,
  ProviderName,
  SenseGlossRequest,
  SenseGlossResult,
} from './provider'

// Deterministic, offline stand-in for a real LLM. Produces a unique, stable
// string per lemma so the whole pipeline — caching, the word panel, and the
// MCQ distractors (#9) — works without any network or API key.
export class StubGlossProvider implements GlossProvider {
  readonly name: ProviderName = 'stub'

  async gloss(req: GlossRequest): Promise<string> {
    return `«${req.lemma}» — glossa stub (${req.pos})`
  }

  async glossSenses(req: SenseGlossRequest): Promise<SenseGlossResult> {
    return {
      translations: req.senses.map((s) => ({
        index: s.index,
        italian: `IT:${s.gloss}`,
      })),
      bestIndex: 0,
    }
  }
}

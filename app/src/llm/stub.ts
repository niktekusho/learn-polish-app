import type {
  ComprehensionRequest,
  ComprehensionResult,
  EpisodeRequest,
  GlossProvider,
  GlossRequest,
  ProviderName,
  SenseGlossRequest,
  SenseGlossResult,
  StoryOutline,
  StoryPremise,
} from "./provider";

// Deterministic, offline stand-in for a real LLM. Produces a unique, stable
// string per lemma so the whole pipeline — caching, the word panel, and the
// MCQ distractors (#9) — works without any network or API key.
export class StubGlossProvider implements GlossProvider {
  readonly name: ProviderName = "stub";

  async gloss(req: GlossRequest): Promise<string> {
    return `«${req.lemma}» — glossa stub (${req.pos})`;
  }

  async glossSenses(req: SenseGlossRequest): Promise<SenseGlossResult> {
    return {
      translations: req.senses.map((s) => ({
        index: s.index,
        italian: `IT:${s.gloss}`,
      })),
      bestIndex: 0,
    };
  }

  async comprehension(req: ComprehensionRequest): Promise<ComprehensionResult> {
    return {
      questions: [
        {
          question: `Domanda stub sul testo (${req.text.length} caratteri)?`,
          choices: ["Risposta giusta (stub)", "Distrattore A", "Distrattore B"],
          correctIndex: 0,
        },
      ],
    };
  }

  async storyPremises(): Promise<StoryPremise[]> {
    return ["giallo", "avventura", "commedia"].map((genre, i) => ({
      title: `Storia stub ${i + 1}`,
      genre,
      hook: `Una storia ${genre} di prova.`,
    }));
  }

  async storyOutline(premise: StoryPremise): Promise<StoryOutline> {
    return { plot: premise.hook, characters: ["Ala"], beats: ["inizio", "svolta", "fine"] };
  }

  async storyEpisode(req: EpisodeRequest): Promise<string> {
    return `Ala ma kota. To jest odcinek ${req.episodeNumber}. Kot jest mały.`;
  }
}

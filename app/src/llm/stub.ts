import type {
  ChoiceQuestion,
  ComprehensionRequest,
  ComprehensionResult,
  EpisodeRequest,
  GeneratedPassage,
  GlossProvider,
  GlossRequest,
  MweCheckItem,
  OccurrenceRequest,
  OccurrenceResult,
  PassageQuestionRequest,
  PassageRequest,
  ProofreadFlag,
  ProviderName,
  ReportReviewItem,
  ReportVerdict,
  SenseGlossRequest,
  SenseGlossResult,
  StoryOutline,
  StoryPremise,
  StoryProvider,
} from "./provider";

// Deterministic, offline stand-in for a real LLM. Produces a unique, stable
// string per lemma so the whole pipeline — caching, the word panel, and the
// MCQ distractors (#9) — works without any network or API key.
export class StubProvider implements GlossProvider, StoryProvider {
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
      occurrence: { index: 0 },
    };
  }

  async glossOccurrence(req: OccurrenceRequest): Promise<OccurrenceResult> {
    if (req.senses.length > 0) return { index: 0 };
    return { italian: `«${req.surface}» — occorrenza stub`, fixed: false, note: null };
  }

  async checkMwes(items: MweCheckItem[]): Promise<boolean[]> {
    return items.map(() => true);
  }

  async reviewReports(items: ReportReviewItem[]): Promise<ReportVerdict[]> {
    return items.map((it) => ({
      gloss: it.senses.length > 0 ? { sense: 0 } : "keep",
      contextBound: it.contextBound,
      reason: "Revisione stub.",
    }));
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

  async proofread(): Promise<ProofreadFlag[]> {
    return [];
  }

  // ponytail: drops the flagged spans; a stub cannot know the right Polish word.
  async correct(text: string, flags: ProofreadFlag[]): Promise<string> {
    return flags
      .reduce((t, f) => t.replaceAll(f.span, ""), text)
      .replace(/ {2,}/g, " ")
      .replace(/ ([.,!?])/g, "$1")
      .trim();
  }

  async premises(): Promise<StoryPremise[]> {
    return ["giallo", "avventura", "commedia"].map((genre, i) => ({
      title: `Storia stub ${i + 1}`,
      genre,
      hook: `Una storia ${genre} di prova.`,
    }));
  }

  async outline(premise: StoryPremise): Promise<StoryOutline> {
    return { plot: premise.hook, characters: ["Ala"], beats: ["inizio", "svolta", "fine"] };
  }

  async episode(req: EpisodeRequest): Promise<string> {
    return `Ala ma kota. To jest odcinek ${req.episodeNumber}. Kot jest mały.`;
  }

  async passage(req: PassageRequest): Promise<GeneratedPassage> {
    return { passage: `To jest ${req.lemma}. Lubię ${req.lemma}.`, target: req.lemma };
  }

  async passageQuestion(req: PassageQuestionRequest): Promise<ChoiceQuestion> {
    return {
      question: `Domanda stub su «${req.target}»?`,
      choices: ["Risposta giusta (stub)", "Distrattore A", "Distrattore B"],
      correctIndex: 0,
    };
  }
}

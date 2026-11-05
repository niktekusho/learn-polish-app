import {
  buildComprehensionPrompt,
  buildCorrectionPrompt,
  buildEpisodePrompt,
  buildGlossPrompt,
  buildMweCheckPrompt,
  buildOccurrencePrompt,
  buildPassageQuestionPrompt,
  buildPremisesPrompt,
  buildProofreadPrompt,
  buildReportReviewPrompt,
  buildSenseGlossPrompt,
  buildStoryOutlinePrompt,
  type ChoiceQuestion,
  type ComprehensionRequest,
  type ComprehensionResult,
  type EpisodeRequest,
  type GlossProvider,
  type GlossRequest,
  type LlmTask,
  type MweCheckItem,
  type OccurrenceRequest,
  type OccurrenceResult,
  parseComprehensionJson,
  parseCorrectedText,
  parseEpisodeText,
  parseGloss,
  parseMweCheckJson,
  parseOccurrenceJson,
  parsePassageQuestionJson,
  parsePremisesJson,
  parseProofreadJson,
  parseReportReviewJson,
  parseSenseGlossJson,
  parseStoryOutlineJson,
  type PassageQuestionRequest,
  type ProofreadFlag,
  type ProviderName,
  type ReportReviewItem,
  type ReportVerdict,
  type SenseGlossRequest,
  type SenseGlossResult,
  type StoryOutline,
  type StoryPremise,
  type StoryProvider,
} from "./provider";

export type LlmCallName =
  | "gloss"
  | "sense-gloss"
  | "occurrence"
  | "comprehension"
  | "passage-question"
  | "mwe-check"
  | "report-review"
  | "proofread"
  | "correction"
  | "premises"
  | "outline"
  | "episode";

/** One LLM call, as the call log records it. */
export interface LlmCall {
  call: LlmCallName;
  model: string;
  promptChars: number;
  ms: number;
  error: string | null; // null when the output parsed
}

/**
 * A provider that sends each prompt to a CLI and parses its stdout. Subclasses
 * supply only the shell-out, injectable so tests skip the process, and the
 * model each task tier runs on. Every call, parsed or not, goes to `log`.
 */
export abstract class CliProvider implements GlossProvider, StoryProvider {
  abstract readonly name: ProviderName;
  protected abstract readonly models: Record<LlmTask, string>;

  constructor(
    private readonly exec: (prompt: string, task: LlmTask) => Promise<string>,
    private readonly log: (call: LlmCall) => void = () => {},
  ) {}

  private async run<T>(
    call: LlmCallName,
    task: LlmTask,
    prompt: string,
    parse: (out: string) => T,
  ) {
    const start = Date.now();
    const entry = { call, model: this.models[task], promptChars: prompt.length };
    try {
      const out = parse(await this.exec(prompt, task));
      this.log({ ...entry, ms: Date.now() - start, error: null });
      return out;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.log({ ...entry, ms: Date.now() - start, error });
      throw err;
    }
  }

  gloss(req: GlossRequest): Promise<string> {
    return this.run("gloss", "gloss", buildGlossPrompt(req), parseGloss);
  }

  glossSenses(req: SenseGlossRequest): Promise<SenseGlossResult> {
    return this.run("sense-gloss", "gloss", buildSenseGlossPrompt(req), (out) =>
      parseSenseGlossJson(out, req.senses.length),
    );
  }

  glossOccurrence(req: OccurrenceRequest): Promise<OccurrenceResult> {
    return this.run("occurrence", "gloss", buildOccurrencePrompt(req), (out) =>
      parseOccurrenceJson(out, req.senses.length),
    );
  }

  comprehension(req: ComprehensionRequest): Promise<ComprehensionResult> {
    return this.run(
      "comprehension",
      "gloss",
      buildComprehensionPrompt(req),
      parseComprehensionJson,
    );
  }

  passageQuestion(req: PassageQuestionRequest): Promise<ChoiceQuestion> {
    return this.run(
      "passage-question",
      "gloss",
      buildPassageQuestionPrompt(req),
      parsePassageQuestionJson,
    );
  }

  checkMwes(items: MweCheckItem[]): Promise<boolean[]> {
    return this.run("mwe-check", "gloss", buildMweCheckPrompt(items), (out) =>
      parseMweCheckJson(out, items.length),
    );
  }

  reviewReports(items: ReportReviewItem[]): Promise<(ReportVerdict | null)[]> {
    return this.run("report-review", "story", buildReportReviewPrompt(items), (out) =>
      parseReportReviewJson(out, items.length),
    );
  }

  proofread(text: string): Promise<ProofreadFlag[]> {
    return this.run("proofread", "check", buildProofreadPrompt(text), (out) =>
      parseProofreadJson(out, text),
    );
  }

  correct(text: string, flags: ProofreadFlag[]): Promise<string> {
    return this.run("correction", "story", buildCorrectionPrompt(text, flags), parseCorrectedText);
  }

  premises(pastGenres: string[]): Promise<StoryPremise[]> {
    return this.run("premises", "story", buildPremisesPrompt(pastGenres), parsePremisesJson);
  }

  outline(premise: StoryPremise): Promise<StoryOutline> {
    return this.run("outline", "story", buildStoryOutlinePrompt(premise), parseStoryOutlineJson);
  }

  episode(req: EpisodeRequest): Promise<string> {
    return this.run("episode", "story", buildEpisodePrompt(req), parseEpisodeText);
  }
}

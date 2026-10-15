import {
  buildComprehensionPrompt,
  buildEpisodePrompt,
  buildGlossPrompt,
  buildMweCheckPrompt,
  buildPassagePrompt,
  buildPassageQuestionPrompt,
  buildPremisesPrompt,
  buildSenseGlossPrompt,
  buildStoryOutlinePrompt,
  type ChoiceQuestion,
  type ComprehensionRequest,
  type ComprehensionResult,
  type EpisodeRequest,
  type GeneratedPassage,
  type GlossProvider,
  type GlossRequest,
  type LlmTask,
  type MweCheckItem,
  parseComprehensionJson,
  parseEpisodeText,
  parseGloss,
  parseMweCheckJson,
  parsePassageJson,
  parsePassageQuestionJson,
  parsePremisesJson,
  parseSenseGlossJson,
  parseStoryOutlineJson,
  type PassageQuestionRequest,
  type PassageRequest,
  type ProviderName,
  type SenseGlossRequest,
  type SenseGlossResult,
  type StoryOutline,
  type StoryPremise,
  type StoryProvider,
} from "./provider";

/**
 * A provider that sends each prompt to a CLI and parses its stdout. Subclasses
 * supply only the shell-out, injectable so tests skip the process. Story calls
 * pass task "story" so a CLI can pick a bigger model for them.
 */
export abstract class CliProvider implements GlossProvider, StoryProvider {
  abstract readonly name: ProviderName;

  constructor(private readonly exec: (prompt: string, task: LlmTask) => Promise<string>) {}

  async gloss(req: GlossRequest): Promise<string> {
    return parseGloss(await this.exec(buildGlossPrompt(req), "gloss"));
  }

  async glossSenses(req: SenseGlossRequest): Promise<SenseGlossResult> {
    return parseSenseGlossJson(
      await this.exec(buildSenseGlossPrompt(req), "gloss"),
      req.senses.length,
    );
  }

  async comprehension(req: ComprehensionRequest): Promise<ComprehensionResult> {
    return parseComprehensionJson(await this.exec(buildComprehensionPrompt(req), "gloss"));
  }

  async passage(req: PassageRequest): Promise<GeneratedPassage> {
    return parsePassageJson(await this.exec(buildPassagePrompt(req), "gloss"));
  }

  async passageQuestion(req: PassageQuestionRequest): Promise<ChoiceQuestion> {
    return parsePassageQuestionJson(await this.exec(buildPassageQuestionPrompt(req), "gloss"));
  }

  async checkMwes(items: MweCheckItem[]): Promise<boolean[]> {
    return parseMweCheckJson(await this.exec(buildMweCheckPrompt(items), "gloss"), items.length);
  }

  async premises(): Promise<StoryPremise[]> {
    return parsePremisesJson(await this.exec(buildPremisesPrompt(), "story"));
  }

  async outline(premise: StoryPremise): Promise<StoryOutline> {
    return parseStoryOutlineJson(await this.exec(buildStoryOutlinePrompt(premise), "story"));
  }

  async episode(req: EpisodeRequest): Promise<string> {
    return parseEpisodeText(await this.exec(buildEpisodePrompt(req), "story"));
  }
}

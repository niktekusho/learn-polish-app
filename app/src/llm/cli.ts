import {
  buildComprehensionPrompt,
  buildEpisodePrompt,
  buildGlossPrompt,
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
  parseComprehensionJson,
  parseEpisodeText,
  parseGloss,
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
 * supply only the shell-out, injectable so tests skip the process.
 */
export abstract class CliProvider implements GlossProvider, StoryProvider {
  abstract readonly name: ProviderName;

  constructor(private readonly exec: (prompt: string) => Promise<string>) {}

  async gloss(req: GlossRequest): Promise<string> {
    return parseGloss(await this.exec(buildGlossPrompt(req)));
  }

  async glossSenses(req: SenseGlossRequest): Promise<SenseGlossResult> {
    return parseSenseGlossJson(await this.exec(buildSenseGlossPrompt(req)), req.senses.length);
  }

  async comprehension(req: ComprehensionRequest): Promise<ComprehensionResult> {
    return parseComprehensionJson(await this.exec(buildComprehensionPrompt(req)));
  }

  async passage(req: PassageRequest): Promise<GeneratedPassage> {
    return parsePassageJson(await this.exec(buildPassagePrompt(req)));
  }

  async passageQuestion(req: PassageQuestionRequest): Promise<ChoiceQuestion> {
    return parsePassageQuestionJson(await this.exec(buildPassageQuestionPrompt(req)));
  }

  async premises(): Promise<StoryPremise[]> {
    return parsePremisesJson(await this.exec(buildPremisesPrompt()));
  }

  async outline(premise: StoryPremise): Promise<StoryOutline> {
    return parseStoryOutlineJson(await this.exec(buildStoryOutlinePrompt(premise)));
  }

  async episode(req: EpisodeRequest): Promise<string> {
    return parseEpisodeText(await this.exec(buildEpisodePrompt(req)));
  }
}

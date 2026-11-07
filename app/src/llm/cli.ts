import { spawn } from "node:child_process";
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
  buildScenePrompt,
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
  parseSceneJson,
  parseSenseGlossJson,
  parseStoryOutlineJson,
  type PassageQuestionRequest,
  type ProofreadFlag,
  type ProviderName,
  type ReportReviewItem,
  type ReportVerdict,
  type SceneProvider,
  type SceneRequest,
  type SceneResult,
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
  | "episode"
  | "scene"
  | "turn";

/** Token counts and API time a CLI reports; null where it reports none. */
export interface Usage {
  inputTokens: number | null; // includes cacheReadTokens
  outputTokens: number | null;
  cacheReadTokens: number | null;
  apiMs: number | null;
}

export interface CliReply {
  text: string;
  usage: Usage;
}

/** One LLM call, as the call log records it. */
export interface LlmCall extends Usage {
  call: LlmCallName;
  model: string;
  effort: string;
  prompt: string;
  response: string | null; // the reply, or the raw CLI output when there is none
  ms: number;
  error: string | null; // null when the output parsed
  conversationId?: number; // Conversation turns only, like the two below
  turn?: number; // the learner turn answered, 0 for an opening
  attempt?: number; // 1 for the first try of a turn
}

export interface ModelChoice {
  model: string;
  effort: string;
}

/** A finished CLI process. A timeout kills it, which leaves `code` null. */
export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type CliExec = (prompt: string, choice: ModelChoice) => Promise<CliRun>;

const TIMEOUT_MS = 60_000;

// stdin is 'ignore' (= /dev/null): `claude -p` otherwise treats the non-TTY pipe
// Node hands it as piped input, waits 3s, warns "no stdin data received", and
// exits non-zero. A spawn error (CLI not on PATH) rejects; any exit resolves.
export function spawnCli(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TIMEOUT_MS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Model and effort per task tier, from `<CLI>_<TIER>_MODEL` and `<CLI>_<TIER>_EFFORT`
 * (e.g. CLAUDE_STORY_EFFORT=low), falling back to `models` at medium effort.
 */
export function tiersFromEnv(
  cli: "CLAUDE" | "CODEX",
  models: Record<LlmTask, string>,
  env: Record<string, string | undefined>,
): Record<LlmTask, ModelChoice> {
  const choice = (task: LlmTask) => ({
    model: env[`${cli}_${task.toUpperCase()}_MODEL`] || models[task],
    effort: env[`${cli}_${task.toUpperCase()}_EFFORT`] || "medium",
  });
  return {
    gloss: choice("gloss"),
    story: choice("story"),
    check: choice("check"),
    conversation: choice("conversation"),
  };
}

export const NO_USAGE: Usage = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  apiMs: null,
};

/**
 * A provider that sends each prompt to a CLI and parses the reply out of its JSON
 * output. Subclasses supply the shell-out, injectable so tests skip the process,
 * and how to read a reply from it. Every call, parsed or not, goes to `log`.
 */
export abstract class CliProvider implements GlossProvider, StoryProvider, SceneProvider {
  abstract readonly name: ProviderName;

  constructor(
    private readonly exec: CliExec,
    private readonly log: (call: LlmCall) => void,
    private readonly tiers: Record<LlmTask, ModelChoice>,
  ) {}

  /** The reply text and usage of a finished run; throws when the CLI failed. */
  protected abstract readReply(run: CliRun): CliReply;

  private async run<T>(
    call: LlmCallName,
    task: LlmTask,
    prompt: string,
    parse: (out: string) => T,
  ) {
    const start = Date.now();
    const choice = this.tiers[task];
    let response: string | null = null;
    let usage = NO_USAGE;
    const log = (error: string | null) =>
      this.log({ call, ...choice, prompt, response, ...usage, ms: Date.now() - start, error });
    try {
      const ran = await this.exec(prompt, choice);
      response = ran.stdout || null;
      const reply = this.readReply(ran);
      response = reply.text;
      usage = reply.usage;
      const out = parse(reply.text);
      log(null);
      return out;
    } catch (err) {
      log(err instanceof Error ? err.message : String(err));
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

  scene(req: SceneRequest): Promise<SceneResult> {
    return this.run("scene", "story", buildScenePrompt(req), (out) => parseSceneJson(out, req));
  }
}

import { spawn } from "node:child_process";
import type { CallOptions, CallSpec, Llm, LlmTier, ProviderName } from "./call";

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
  call: string; // the spec name
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
 * Model and effort per tier, from `<CLI>_<TIER>_MODEL` and `<CLI>_<TIER>_EFFORT`
 * (e.g. CLAUDE_STORY_EFFORT=low), falling back to `models` at medium effort.
 */
export function tiersFromEnv(
  cli: "CLAUDE" | "CODEX",
  models: Record<LlmTier, string>,
  env: Record<string, string | undefined>,
): Record<LlmTier, ModelChoice> {
  const choice = (tier: LlmTier) => ({
    model: env[`${cli}_${tier.toUpperCase()}_MODEL`] || models[tier],
    effort: env[`${cli}_${tier.toUpperCase()}_EFFORT`] || "medium",
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
export abstract class CliProvider implements Llm {
  abstract readonly name: ProviderName;

  constructor(
    private readonly exec: CliExec,
    private readonly log: (call: LlmCall) => void,
    private readonly tiers: Record<LlmTier, ModelChoice>,
  ) {}

  /** The reply text and usage of a finished run; throws when the CLI failed. */
  protected abstract readReply(run: CliRun): CliReply;

  call<Req, Res>(spec: CallSpec<Req, Res>, req: Req, options?: CallOptions): Promise<Res> {
    const choice = this.tiers[spec.tier];
    const prompt = spec.prompt(req);
    return loggedCall(
      { call: spec.name, ...choice, prompt, conversationId: options?.conversationId },
      () => this.exec(prompt, choice),
      (run) => this.readReply(run),
      (text) => spec.parse(text, req),
      this.log,
    );
  }
}

/** What a call log entry knows before the call runs. */
export type CallEntry = Omit<LlmCall, keyof Usage | "response" | "ms" | "error">;

/**
 * Runs one CLI call: times it, reads the reply out of the run, parses it and logs the
 * call, parsed or not. A failure rethrows after the log, so the caller caches nothing.
 */
export async function loggedCall<T>(
  entry: CallEntry,
  exec: () => Promise<CliRun>,
  readReply: (run: CliRun) => CliReply,
  parse: (text: string) => T,
  log: (call: LlmCall) => void,
): Promise<T> {
  const start = Date.now();
  let response: string | null = null;
  let usage = NO_USAGE;
  const logged = (error: string | null) =>
    log({ ...entry, response, ...usage, ms: Date.now() - start, error });
  try {
    const ran = await exec();
    response = ran.stdout || null;
    const reply = readReply(ran);
    response = reply.text;
    usage = reply.usage;
    const out = parse(reply.text);
    logged(null);
    return out;
  } catch (err) {
    logged(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

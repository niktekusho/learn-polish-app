import {
  CliProvider,
  type CliExec,
  type CliReply,
  type CliRun,
  type LlmCall,
  type ModelChoice,
  NO_USAGE,
  spawnCli,
  tiersFromEnv,
} from "./cli";
import type { LlmTask, ProviderName } from "./provider";

// Real Italian gloss via the `codex` CLI already on PATH. `codex exec --json` prints
// one JSON event per line: the reply is the last agent message, and the usage comes
// with `turn.completed`. It reports no API time.

// "codex" is Codex's configured default model, which gets no --model flag.
const DEFAULT_MODEL = "codex";
const MODELS: Record<LlmTask, string> = {
  gloss: DEFAULT_MODEL,
  story: DEFAULT_MODEL,
  check: DEFAULT_MODEL,
};

export const codexTiers = (env: Record<string, string | undefined> = process.env) =>
  tiersFromEnv("CODEX", MODELS, env);

export function buildCodexArgs(prompt: string, { model, effort }: ModelChoice): string[] {
  return [
    "exec",
    "--color",
    "never",
    "--json",
    ...(model === DEFAULT_MODEL ? [] : ["-m", model]),
    "-c",
    `model_reasoning_effort="${effort}"`,
    prompt,
  ];
}

const runCodex: CliExec = (prompt, choice) => spawnCli("codex", buildCodexArgs(prompt, choice));

interface CodexEvent {
  type?: string;
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
  message?: string;
}

function readCodexReply(run: CliRun): CliReply {
  if (run.code !== 0) throw new Error(`codex exited ${run.code}: ${run.stderr.trim()}`);
  let text: string | null = null;
  let usage = NO_USAGE;
  // An `error` event can be a stream error Codex retries, so only a missing reply fails on it.
  let lastError: string | null = null;
  for (const line of run.stdout.split("\n")) {
    let event: CodexEvent;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      text = event.item.text ?? null;
    } else if (event.type === "turn.completed" && event.usage) {
      usage = {
        inputTokens: event.usage.input_tokens ?? null,
        outputTokens: event.usage.output_tokens ?? null,
        cacheReadTokens: event.usage.cached_input_tokens ?? null,
        apiMs: null,
      };
    } else if (event.type === "turn.failed") {
      throw new Error(`codex turn failed: ${event.error?.message ?? "no message"}`);
    } else if (event.type === "error") {
      lastError = event.message ?? null;
    }
  }
  if (text === null) throw new Error(`codex printed no agent message: ${lastError ?? "no error"}`);
  return { text, usage };
}

export class CodexCliProvider extends CliProvider {
  readonly name: ProviderName = "codex-cli";

  constructor(
    exec: CliExec = runCodex,
    log: (call: LlmCall) => void = () => {},
    tiers = codexTiers(),
  ) {
    super(exec, log, tiers);
  }

  protected readReply(run: CliRun) {
    return readCodexReply(run);
  }
}

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  CliProvider,
  type CliExec,
  type CliReply,
  type CliRun,
  type LlmCall,
  type ModelChoice,
  spawnCli,
  tiersFromEnv,
} from "./cli";
import type { LlmTask, ProviderName } from "./provider";

// Real Italian gloss via the `claude` CLI already on PATH (bills the user's
// subscription, no API key). One-shot per call: `claude -p "<prompt>"` prints
// the reply and its usage as one JSON object.

// Without --model the CLI uses the plan's default (a large model). Glosses are short.
// A checking call runs on a stronger model than the one that wrote the text.
const MODELS: Record<LlmTask, string> = {
  gloss: "claude-haiku-5-5",
  story: "claude-sonnet-5-5",
  check: "claude-opus-5-5",
  conversation: "claude-haiku-5-5",
};

export const claudeTiers = (env: Record<string, string | undefined> = process.env) =>
  tiersFromEnv("CLAUDE", MODELS, env);

// Strips everything a one-shot or session call does not need (tools, MCP, settings/hooks,
// skills, Chrome, session files) so each call sends a minimal prompt. --bare is
// not usable: it drops OAuth, so it would bill an API key instead of the subscription.
export const LEAN_ARGS = [
  "--tools",
  "",
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--no-chrome",
  "--disable-slash-commands",
  "--no-session-persistence",
];
// Empty cwd: no CLAUDE.md or .claude/ discovery.
export const EMPTY_CWD = mkdtempSync(join(tmpdir(), "claude-"));

// The prompt is a single argv element, so the pasted sentence can't shell-inject.
export function runClaude(prompt: string, { model, effort }: ModelChoice): Promise<CliRun> {
  return spawnCli(
    "claude",
    [
      "--model",
      model,
      "--effort",
      effort,
      "--output-format",
      "json",
      "--system-prompt",
      "Reply with only what the prompt asks.",
      ...LEAN_ARGS,
      "-p",
      prompt,
    ],
    { cwd: EMPTY_CWD },
  );
}

const claudeResult = z.object({
  is_error: z.boolean(),
  subtype: z.string().optional(),
  result: z.string().optional(),
  duration_api_ms: z.number().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
});

export function readClaudeReply(run: CliRun): CliReply {
  if (run.code !== 0) {
    throw new Error(`claude exited ${run.code}: ${run.stderr.trim() || run.stdout.trim()}`);
  }
  let json: z.infer<typeof claudeResult>;
  try {
    json = claudeResult.parse(JSON.parse(run.stdout));
  } catch {
    throw new Error("claude output is not its JSON result");
  }
  if (json.is_error || json.result === undefined) {
    throw new Error(`claude returned an error: ${json.subtype ?? "no result"}`);
  }
  const u = json.usage;
  // The CLI counts cached and freshly cached input apart from input_tokens.
  const inputTokens =
    u?.input_tokens === undefined
      ? null
      : u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  return {
    text: json.result,
    usage: {
      inputTokens,
      outputTokens: u?.output_tokens ?? null,
      cacheReadTokens: u?.cache_read_input_tokens ?? null,
      apiMs: json.duration_api_ms ?? null,
    },
  };
}

export class ClaudeCliProvider extends CliProvider {
  readonly name: ProviderName = "claude-cli";

  constructor(
    exec: CliExec = runClaude,
    log: (call: LlmCall) => void = () => {},
    tiers = claudeTiers(),
  ) {
    super(exec, log, tiers);
  }

  protected readReply(run: CliRun) {
    return readClaudeReply(run);
  }
}

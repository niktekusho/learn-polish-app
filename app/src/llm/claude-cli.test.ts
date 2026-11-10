import { expect, test } from "vitest";
import { claudeTiers, ClaudeCliProvider } from "./claude-cli";
import type { CallSpec } from "./call";
import type { CliRun, LlmCall, ModelChoice } from "./cli";

/** Replies with the trimmed text, so these tests see only what the adapter does. */
const echo: CallSpec<{ word: string }, string> = {
  name: "echo",
  tier: "gloss",
  prompt: (req) => `Say ${req.word}.`,
  parse: (text) => {
    const out = text.trim();
    if (!out) throw new Error("empty reply");
    return out;
  },
  stub: (req) => req.word,
};

const req = { word: "robić" };

/** A check-tier spec whose parser rejects every reply. */
const strict: CallSpec<{ word: string }, string> = {
  ...echo,
  name: "strict",
  tier: "check",
  parse: () => {
    throw new Error("reply is not JSON");
  },
};

/** What `claude -p --output-format json` prints for a reply. */
function claudeJson(result: string): CliRun {
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 2100,
    duration_api_ms: 1800,
    result,
    usage: {
      input_tokens: 12,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 300,
      output_tokens: 7,
    },
  });
  return { code: 0, stdout, stderr: "" };
}

test("provider returns the parsed reply from the CLI's JSON output", async () => {
  const provider = new ClaudeCliProvider(async () => claudeJson("fare\n"));
  expect(await provider.call(echo, req)).toBe("fare");
});

test("provider bubbles a CLI failure so nothing gets cached", async () => {
  const provider = new ClaudeCliProvider(async () => ({ code: 1, stdout: "", stderr: "boom" }));
  await expect(provider.call(echo, req)).rejects.toThrow(/claude exited 1: boom/);
});

/** A story-tier spec. */
const tale: CallSpec<{ word: string }, string> = { ...echo, name: "tale", tier: "story" };

test("each task tier runs on its default model at medium effort", async () => {
  const choices: ModelChoice[] = [];
  const provider = new ClaudeCliProvider(async (_prompt, choice) => {
    choices.push(choice);
    return claudeJson(choice.model === "claude-sonnet-5-5" ? "Ala ma kota." : "fare");
  });
  await provider.call(echo, req);
  await provider.call(tale, req);
  await provider.call(strict, req).catch(() => {});
  expect(choices).toEqual([
    { model: "claude-haiku-5-5", effort: "medium" },
    { model: "claude-sonnet-5-5", effort: "medium" },
    { model: "claude-opus-5-5", effort: "medium" },
  ]);
});

test("env vars change the model and effort of one task tier", async () => {
  const calls: LlmCall[] = [];
  const tiers = claudeTiers({ CLAUDE_STORY_MODEL: "claude-haiku-5-5", CLAUDE_STORY_EFFORT: "low" });
  const provider = new ClaudeCliProvider(
    async (_prompt, choice) => claudeJson(choice.effort === "low" ? "Ala ma kota." : "fare"),
    (c) => calls.push(c),
    tiers,
  );
  await provider.call(echo, req);
  await provider.call(tale, req);
  expect(calls).toMatchObject([
    { call: "echo", model: "claude-haiku-5-5", effort: "medium" },
    { call: "tale", model: "claude-haiku-5-5", effort: "low" },
  ]);
});

test("a call is logged with its prompt, reply, usage and API time", async () => {
  const calls: LlmCall[] = [];
  const provider = new ClaudeCliProvider(
    async () => claudeJson("fare\n"),
    (c) => calls.push(c),
  );
  await provider.call(echo, req);
  expect(calls).toEqual([
    {
      call: "echo",
      model: "claude-haiku-5-5",
      effort: "medium",
      prompt: expect.stringContaining("robić"),
      response: "fare\n",
      inputTokens: 412,
      outputTokens: 7,
      cacheReadTokens: 300,
      apiMs: 1800,
      ms: expect.any(Number),
      error: null,
    },
  ]);
});

test("a reply that fails to parse is logged with the reply and the parse error", async () => {
  const calls: LlmCall[] = [];
  const provider = new ClaudeCliProvider(
    async () => claudeJson("fare"),
    (c) => calls.push(c),
  );
  await expect(provider.call(strict, req)).rejects.toThrow();
  expect(calls).toMatchObject([
    {
      call: "strict",
      model: "claude-opus-5-5",
      prompt: expect.stringContaining("robić"),
      response: "fare",
      outputTokens: 7,
      error: expect.stringMatching(/not JSON/),
    },
  ]);
});

test("a non-zero exit is logged with the raw output and the exit error", async () => {
  const calls: LlmCall[] = [];
  const provider = new ClaudeCliProvider(
    async () => ({ code: 1, stdout: "partial", stderr: "rate limited" }),
    (c) => calls.push(c),
  );
  await expect(provider.call(echo, req)).rejects.toThrow();
  expect(calls).toMatchObject([
    {
      prompt: expect.stringContaining("robić"),
      response: "partial",
      inputTokens: null,
      apiMs: null,
      error: "claude exited 1: rate limited",
    },
  ]);
});

test("output that is not the CLI's JSON is a failure that keeps the raw output", async () => {
  const calls: LlmCall[] = [];
  const provider = new ClaudeCliProvider(
    async () => ({ code: 0, stdout: "fare", stderr: "" }),
    (c) => calls.push(c),
  );
  await expect(provider.call(echo, req)).rejects.toThrow();
  expect(calls).toMatchObject([{ response: "fare", error: expect.stringMatching(/JSON/) }]);
});

test("a CLI error result is a failure", async () => {
  const stdout = JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    duration_api_ms: 50,
    usage: { input_tokens: 3, output_tokens: 0 },
  });
  const provider = new ClaudeCliProvider(async () => ({ code: 0, stdout, stderr: "" }));
  await expect(provider.call(echo, req)).rejects.toThrow(/error_during_execution/);
});

test("call() runs a spec on its tier's model and logs the call under the spec's name", async () => {
  const calls: LlmCall[] = [];
  const prompts: string[] = [];
  const upper: CallSpec<{ word: string }, string> = {
    name: "upper",
    tier: "story",
    prompt: (req) => `Write ${req.word} in capitals.`,
    parse: (text, req) => {
      if (text !== req.word.toUpperCase()) throw new Error(`not ${req.word} in capitals`);
      return text;
    },
    stub: (req) => req.word.toUpperCase(),
  };
  const provider = new ClaudeCliProvider(
    async (prompt) => {
      prompts.push(prompt);
      return claudeJson(prompts.length > 1 ? "kot" : "KOT");
    },
    (c) => calls.push(c),
  );

  expect(await provider.call(upper, { word: "kot" }, { conversationId: 7 })).toBe("KOT");
  await expect(provider.call(upper, { word: "kot" })).rejects.toThrow(/not kot in capitals/);
  expect(prompts).toEqual(["Write kot in capitals.", "Write kot in capitals."]);
  expect(calls).toMatchObject([
    { call: "upper", model: "claude-sonnet-5-5", error: null, conversationId: 7 },
    { call: "upper", model: "claude-sonnet-5-5", response: "kot", error: "not kot in capitals" },
  ]);
});

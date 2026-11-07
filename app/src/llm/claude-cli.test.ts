import { expect, test } from "vitest";
import { parseGloss } from "./provider";
import { claudeTiers, ClaudeCliProvider } from "./claude-cli";
import type { CliRun, LlmCall, ModelChoice } from "./cli";

const req = { lemma: "robić", pos: "VERB", sentence: "Robię obiad w kuchni." };

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

test("parseGloss trims a valid one-liner", () => {
  expect(parseGloss("  fare\n")).toBe("fare");
});

test("parseGloss rejects empty output", () => {
  expect(() => parseGloss("   \n")).toThrow();
});

test("parseGloss rejects a rambling response (too long)", () => {
  expect(() => parseGloss("Ecco la glossa: ".repeat(10))).toThrow();
});

test("provider returns the parsed reply from the CLI's JSON output", async () => {
  const provider = new ClaudeCliProvider(async () => claudeJson("fare\n"));
  expect(await provider.gloss(req)).toBe("fare");
});

test("provider bubbles a CLI failure so nothing gets cached", async () => {
  const provider = new ClaudeCliProvider(async () => ({ code: 1, stdout: "", stderr: "boom" }));
  await expect(provider.gloss(req)).rejects.toThrow(/claude exited 1: boom/);
});

test("provider drops an echoed surface form before the arrow", async () => {
  const provider = new ClaudeCliProvider(async () => claudeJson("swoich → proprio\n"));
  const swoj = { lemma: "swój", pos: "DET", sentence: "Mają swoich przyjaciół." };
  expect(await provider.gloss(swoj)).toBe("proprio");
});

const episodeReq = {
  premise: { title: "t", genre: "g", hook: "h" },
  outline: { plot: "p", characters: [], beats: ["b"] },
  previous: null,
  episodeNumber: 1,
  totalEpisodes: 1,
  newShare: 0.15,
};

test("each task tier runs on its default model at medium effort", async () => {
  const choices: ModelChoice[] = [];
  const provider = new ClaudeCliProvider(async (_prompt, choice) => {
    choices.push(choice);
    return claudeJson(choice.model === "claude-sonnet-5-5" ? "Ala ma kota." : "fare");
  });
  await provider.gloss(req);
  await provider.episode(episodeReq);
  await provider.proofread("Ala ma kota.").catch(() => {});
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
  await provider.gloss(req);
  await provider.episode(episodeReq);
  expect(calls).toMatchObject([
    { call: "gloss", model: "claude-haiku-5-5", effort: "medium" },
    { call: "episode", model: "claude-haiku-5-5", effort: "low" },
  ]);
});

test("a call is logged with its prompt, reply, usage and API time", async () => {
  const calls: LlmCall[] = [];
  const provider = new ClaudeCliProvider(
    async () => claudeJson("fare\n"),
    (c) => calls.push(c),
  );
  await provider.gloss(req);
  expect(calls).toEqual([
    {
      call: "gloss",
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
  await expect(provider.proofread("Ala ma kota.")).rejects.toThrow();
  expect(calls).toMatchObject([
    {
      call: "proofread",
      model: "claude-opus-5-5",
      prompt: expect.stringContaining("Ala ma kota."),
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
  await expect(provider.gloss(req)).rejects.toThrow();
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
  await expect(provider.gloss(req)).rejects.toThrow();
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
  await expect(provider.gloss(req)).rejects.toThrow(/error_during_execution/);
});

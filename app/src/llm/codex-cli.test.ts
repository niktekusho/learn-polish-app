import { expect, test } from "vitest";
import { parseGloss } from "./provider";
import type { CliRun, LlmCall } from "./cli";
import { buildCodexArgs, codexTiers, CodexCliProvider } from "./codex-cli";

const req = { lemma: "robić", pos: "VERB", sentence: "Robię obiad w kuchni." };

/** What `codex exec --json` prints for a reply: one JSON event per line. */
function codexJsonl(text: string): CliRun {
  const events = [
    { type: "thread.started", thread_id: "t1" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
    { type: "item.completed", item: { id: "item_1", type: "agent_message", text } },
    {
      type: "turn.completed",
      usage: { input_tokens: 400, cached_input_tokens: 300, output_tokens: 9 },
    },
  ];
  return { code: 0, stdout: events.map((e) => JSON.stringify(e)).join("\n") + "\n", stderr: "" };
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

test("provider returns the parsed agent message from the CLI's JSON events", async () => {
  const provider = new CodexCliProvider(async () => codexJsonl("fare\n"));
  expect(await provider.gloss(req)).toBe("fare");
});

test("codex runs the configured default model unless an env var names one", () => {
  expect(buildCodexArgs("prompt", { model: "codex", effort: "medium" })).toEqual([
    "exec",
    "--color",
    "never",
    "--json",
    "-c",
    'model_reasoning_effort="medium"',
    "prompt",
  ]);
  const tiers = codexTiers({ CODEX_STORY_MODEL: "gpt-5.5", CODEX_STORY_EFFORT: "high" });
  expect(tiers.gloss).toEqual({ model: "codex", effort: "medium" });
  expect(buildCodexArgs("prompt", tiers.story)).toEqual([
    "exec",
    "--color",
    "never",
    "--json",
    "-m",
    "gpt-5.5",
    "-c",
    'model_reasoning_effort="high"',
    "prompt",
  ]);
});

test("provider bubbles a CLI failure so nothing gets cached", async () => {
  const provider = new CodexCliProvider(async () => ({ code: 1, stdout: "", stderr: "boom" }));
  await expect(provider.gloss(req)).rejects.toThrow(/codex exited 1: boom/);
});

test("a call is logged with its usage; API time stays null", async () => {
  const calls: LlmCall[] = [];
  const provider = new CodexCliProvider(
    async () => codexJsonl("fare\n"),
    (c) => calls.push(c),
  );
  await provider.gloss(req);
  expect(calls).toEqual([
    {
      call: "gloss",
      model: "codex",
      effort: "medium",
      prompt: expect.stringContaining("robić"),
      response: "fare\n",
      inputTokens: 400,
      outputTokens: 9,
      cacheReadTokens: 300,
      apiMs: null,
      ms: expect.any(Number),
      error: null,
    },
  ]);
});

test("a failed turn is a failure that keeps the raw events", async () => {
  const calls: LlmCall[] = [];
  const stdout = JSON.stringify({ type: "turn.failed", error: { message: "quota" } });
  const provider = new CodexCliProvider(
    async () => ({ code: 0, stdout, stderr: "" }),
    (c) => calls.push(c),
  );
  await expect(provider.gloss(req)).rejects.toThrow(/quota/);
  expect(calls).toMatchObject([{ response: stdout, error: expect.stringMatching(/quota/) }]);
});

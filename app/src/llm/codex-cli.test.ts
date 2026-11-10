import { expect, test } from "vitest";
import type { CallSpec } from "./call";
import type { CliRun, LlmCall } from "./cli";
import { buildCodexArgs, codexTiers, CodexCliProvider } from "./codex-cli";

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

test("provider returns the parsed agent message from the CLI's JSON events", async () => {
  const provider = new CodexCliProvider(async () => codexJsonl("fare\n"));
  expect(await provider.call(echo, req)).toBe("fare");
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
  await expect(provider.call(echo, req)).rejects.toThrow(/codex exited 1: boom/);
});

test("a call is logged with its usage; API time stays null", async () => {
  const calls: LlmCall[] = [];
  const provider = new CodexCliProvider(
    async () => codexJsonl("fare\n"),
    (c) => calls.push(c),
  );
  await provider.call(echo, req);
  expect(calls).toEqual([
    {
      call: "echo",
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
  await expect(provider.call(echo, req)).rejects.toThrow(/quota/);
  expect(calls).toMatchObject([{ response: stdout, error: expect.stringMatching(/quota/) }]);
});

test("call() logs a spec's parse failure under its name, with the reply", async () => {
  const calls: LlmCall[] = [];
  const count: CallSpec<{ items: string[] }, number> = {
    name: "count",
    tier: "check",
    prompt: (req) => `Count: ${req.items.join(", ")}`,
    parse: (text, req) => {
      const n = Number(text.trim());
      if (n !== req.items.length)
        throw new Error(`count ${text.trim()} is not ${req.items.length}`);
      return n;
    },
    stub: (req) => req.items.length,
  };
  const provider = new CodexCliProvider(
    async () => codexJsonl("3"),
    (c) => calls.push(c),
    codexTiers({ CODEX_CHECK_MODEL: "gpt-5.5" }),
  );

  await expect(provider.call(count, { items: ["a", "b"] })).rejects.toThrow(/count 3 is not 2/);
  expect(calls).toMatchObject([
    {
      call: "count",
      model: "gpt-5.5",
      prompt: "Count: a, b",
      response: "3",
      error: "count 3 is not 2",
    },
  ]);
});

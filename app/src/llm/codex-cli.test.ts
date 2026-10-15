import { expect, test } from "vitest";
import { parseGloss } from "./provider";
import { buildCodexArgs, CodexCliProvider } from "./codex-cli";

const req = { lemma: "robić", pos: "VERB", sentence: "Robię obiad w kuchni." };

test("parseGloss trims a valid one-liner", () => {
  expect(parseGloss("  fare\n")).toBe("fare");
});

test("parseGloss rejects empty output", () => {
  expect(() => parseGloss("   \n")).toThrow();
});

test("parseGloss rejects a rambling response (too long)", () => {
  expect(() => parseGloss("Ecco la glossa: ".repeat(10))).toThrow();
});

test("provider returns the parsed CLI final message", async () => {
  const provider = new CodexCliProvider(async () => "fare\n");
  expect(await provider.gloss(req)).toBe("fare");
});

test("codex invocation uses portable exec flags only", () => {
  expect(buildCodexArgs("prompt", "/tmp/out")).toEqual([
    "exec",
    "--color",
    "never",
    "--output-last-message",
    "/tmp/out",
    "prompt",
  ]);
});

test("provider bubbles a CLI failure so nothing gets cached", async () => {
  const provider = new CodexCliProvider(async () => {
    throw new Error("codex exited 1");
  });
  await expect(provider.gloss(req)).rejects.toThrow();
});

import { expect, test } from "vitest";
import type { ConversationSession, SessionSeed } from "./conversation-session";
import { ScriptedSession } from "./scripted-session";

const seed: SessionSeed = { brief: "b", stepIds: ["order", "pay"], transcript: [] };

test("the stub plays its canned turns in order, then repeats the last", async () => {
  const s: ConversationSession = new ScriptedSession();
  const opening = await s.start(seed);
  const second = await s.send("Poproszę bułkę.");
  expect(opening.line).not.toBe(second.line);
  expect(await s.send("Dziękuję.")).toEqual(await s.send("Do widzenia."));
});

test("canned turns only tick the scene's step ids", async () => {
  const s: ConversationSession = new ScriptedSession();
  await s.start({ ...seed, stepIds: ["pay"] });
  for (let i = 0; i < 6; i++) {
    expect((await s.send("x")).stepsTicked.every((id) => id === "pay")).toBe(true);
  }
});

test("a turn before start fails, as it does on the real session", async () => {
  const s: ConversationSession = new ScriptedSession();
  await expect(s.send("x")).rejects.toThrow(/not started/);
});

test("a warmed stub skips the lines already in the transcript", async () => {
  const s: ConversationSession = new ScriptedSession();
  s.warm({ ...seed, transcript: [{ speaker: "character", text: "Dzień dobry!" }] });
  expect((await s.send("Poproszę dwie bułki.")).stepsTicked).toEqual(["order"]);
});

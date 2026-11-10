import { expect, test } from "vitest";
import type { CallSpec } from "./call";
import { fakeLlm } from "./fake";

const spec = (name: string): CallSpec<{ word: string }, string> => ({
  name,
  tier: "gloss",
  prompt: (req) => req.word,
  parse: (text) => text,
  stub: (req) => `stub:${req.word}`,
});

test("a call answers with the spec's stub unless an answer is set for its name", async () => {
  const llm = fakeLlm({ answers: { b: (req: { word: string }) => `b:${req.word}` } });
  expect(await llm.call(spec("a"), { word: "kot" })).toBe("stub:kot");
  expect(await llm.call(spec("b"), { word: "pies" })).toBe("b:pies");
  expect(llm.name).toBe("stub");
});

test("every call is recorded with its spec name, request and options", async () => {
  const llm = fakeLlm({ name: "claude-cli" });
  await llm.call(spec("a"), { word: "kot" });
  await llm.call(spec("b"), { word: "pies" }, { conversationId: 3 });
  expect(llm.name).toBe("claude-cli");
  expect(llm.calls).toEqual([
    { name: "a", req: { word: "kot" } },
    { name: "b", req: { word: "pies" }, options: { conversationId: 3 } },
  ]);
});

test("each call takes one entry off the failure queue; a null entry succeeds", async () => {
  const llm = fakeLlm({ fails: [new Error("first"), null, new Error("third")] });
  await expect(llm.call(spec("a"), { word: "kot" })).rejects.toThrow("first");
  expect(await llm.call(spec("b"), { word: "kot" })).toBe("stub:kot");
  await expect(llm.call(spec("a"), { word: "kot" })).rejects.toThrow("third");
  expect(await llm.call(spec("a"), { word: "kot" })).toBe("stub:kot");
  expect(llm.calls).toHaveLength(4);
});

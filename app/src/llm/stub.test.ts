import { expect, test } from "vitest";
import type { CallSpec } from "./call";
import { StubProvider } from "./stub";

test("the stub answers a call with the spec's own stub for that request", async () => {
  const spec: CallSpec<{ items: string[] }, boolean[]> = {
    name: "keep",
    tier: "gloss",
    prompt: () => {
      throw new Error("the stub builds no prompt");
    },
    parse: () => {
      throw new Error("the stub parses nothing");
    },
    stub: (req) => req.items.map((i) => i !== "no"),
  };
  expect(await new StubProvider().call(spec, { items: ["yes", "no"] })).toEqual([true, false]);
});

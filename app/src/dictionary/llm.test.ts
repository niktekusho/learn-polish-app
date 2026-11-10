import { expect, test } from "vitest";
import { type MweCheckItem, mweCheck } from "./llm";

const item: MweCheckItem = {
  headword: "to jest",
  meaning: "that is to say",
  sentence: "To jest chleb.",
};
const items = (n: number) => Array.from({ length: n }, () => item);

test("MWE check: one verdict per item, in order", () => {
  expect(mweCheck.parse(JSON.stringify({ keep: [true, false] }), items(2))).toEqual([true, false]);
  expect(mweCheck.parse('```json\n{"keep":[false]}\n```', items(1))).toEqual([false]);
  expect(() => mweCheck.parse(JSON.stringify({ keep: [true] }), items(2))).toThrow(/2/);
  expect(() => mweCheck.parse(JSON.stringify({ keep: ["yes"] }), items(1))).toThrow();
});

test("MWE check: the prompt numbers each item with its meaning and sentence", () => {
  expect(mweCheck.prompt(items(1))).toContain(
    "1. Espressione: to jest\nSignificato: that is to say\nFrase: To jest chleb.",
  );
});

import { expect, test } from "vitest";
import { passageQuestion } from "./llm";

const req = { passage: "Idę do sklepu.", lemma: "do", target: "do" };

test("passage question: 3–4 distinct choices with an in-range answer", () => {
  const q = { question: "Dove?", choices: ["a", "b", "c"], correctIndex: 2 };
  const parse = (reply: unknown) => passageQuestion.parse(JSON.stringify(reply), req);
  expect(parse(q)).toEqual(q);
  expect(() => parse({ ...q, correctIndex: 3 })).toThrow();
  expect(() => parse({ ...q, choices: ["a", "b"] })).toThrow();
  expect(() => parse({ ...q, choices: ["a", "a", "c"] })).toThrow(/duplicate/);
});

test("passage question: the prompt names the target word and carries the passage", () => {
  const prompt = passageQuestion.prompt(req);
  expect(prompt).toContain("«do» (lemma: do)");
  expect(prompt).toContain("Testo:\nIdę do sklepu.");
});

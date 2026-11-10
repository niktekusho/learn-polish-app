import { expect, test } from "vitest";
import { comprehension } from "./llm";

const req = { text: "Ala ma kota." };

const goodCheck = JSON.stringify({
  questions: [
    { question: "Di cosa parla il testo?", choices: ["gatti", "cani", "case"], correctIndex: 0 },
  ],
});

test("comprehension: parses plain JSON and strips fences", () => {
  expect(comprehension.parse(goodCheck, req).questions).toHaveLength(1);
  const fenced = "```json\n" + goodCheck + "\n```";
  expect(comprehension.parse(fenced, req).questions[0].correctIndex).toBe(0);
});

test("comprehension: throws on junk, empty questions, bad choice counts", () => {
  expect(() => comprehension.parse("Ecco le domande: ...", req)).toThrow(/not JSON/);
  expect(() => comprehension.parse('{"questions":[]}', req)).toThrow();
  const twoChoices = JSON.stringify({
    questions: [{ question: "Q?", choices: ["a", "b"], correctIndex: 0 }],
  });
  expect(() => comprehension.parse(twoChoices, req)).toThrow();
  const fiveChoices = JSON.stringify({
    questions: [{ question: "Q?", choices: ["a", "b", "c", "d", "e"], correctIndex: 0 }],
  });
  expect(() => comprehension.parse(fiveChoices, req)).toThrow();
});

test("comprehension: throws on more than 10 questions", () => {
  const many = JSON.stringify({
    questions: Array.from({ length: 11 }, (_, i) => ({
      question: `Q${i}?`,
      choices: ["a", "b", "c"],
      correctIndex: 0,
    })),
  });
  expect(() => comprehension.parse(many, req)).toThrow();
});

test("comprehension: throws on out-of-range correctIndex", () => {
  const bad = JSON.stringify({
    questions: [{ question: "Q?", choices: ["a", "b", "c"], correctIndex: 3 }],
  });
  expect(() => comprehension.parse(bad, req)).toThrow(/out of range/);
});

test("comprehension: prompt embeds the text and demands JSON", () => {
  const prompt = comprehension.prompt(req);
  expect(prompt).toContain("Ala ma kota.");
  expect(prompt).toContain("correctIndex");
});

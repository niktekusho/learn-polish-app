import { expect, test } from "vitest";
import { Rating } from "#/fsrs/index";
import { passage } from "./passage";
import type { ExerciseCandidate } from "./types";

const target: ExerciseCandidate = {
  lemmaId: 1,
  lemma: "do",
  pos: "ADP",
  passage: {
    questionId: 7,
    passage: "Idę do sklepu. Kupuję chleb.",
    target: "do",
    question: "Dove va la persona?",
    choices: ["al negozio", "a casa", "a scuola"],
    correctIndex: 0,
  },
};

test("applies only with a prepared passage question", () => {
  expect(passage.appliesTo(target)).toBe(true);
  expect(passage.appliesTo({ lemmaId: 1, lemma: "do", pos: "ADP", gloss: "a" })).toBe(false);
});

test("generate keeps the right answer under the shuffle", () => {
  const item = passage.generate(target, [])!;
  expect(item.choices).toHaveLength(3);
  expect(item.choices[item.correctIndex]).toBe("al negozio");
  expect(item).toMatchObject({ lemmaId: 1, questionId: 7, target: "do" });
});

test("the client item carries the passage and question but no answer", () => {
  const item = passage.generate(target, [])!;
  const client = passage.toClient(item);
  expect(client).toEqual({
    id: item.id,
    kind: "passage",
    passage: "Idę do sklepu. Kupuję chleb.",
    target: "do",
    question: "Dove va la persona?",
    choices: item.choices,
  });
});

test("right choice grades Good, wrong grades Again", () => {
  const item = passage.generate(target, [])!;
  expect(passage.grade(item, { choiceIndex: item.correctIndex })).toBe(Rating.Good);
  expect(passage.grade(item, { choiceIndex: (item.correctIndex + 1) % 3 })).toBe(Rating.Again);
});

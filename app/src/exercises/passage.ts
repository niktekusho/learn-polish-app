import { Rating } from "#/fsrs/index";
import type { McqResponse } from "./recognition-mcq";
import type { Exercise } from "./types";

/** Full item, held server-side. Carries the answer: never sent to the client. */
export interface PassageItem {
  id: string;
  lemmaId: number;
  questionId: number; // the cached passage_question row (report deletes it)
  passage: string;
  target: string;
  question: string;
  choices: string[];
  correctIndex: number;
}
export interface PassageClientItem {
  id: string;
  kind: "passage";
  passage: string;
  target: string; // highlighted in the passage, never glossed
  question: string;
  choices: string[];
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Passage exercise (CONTEXT.md). Grades Receptive like recognition MCQ.
 * Questions are prepared ahead by the passage service: session build only reads them.
 */
export const passage: Exercise<PassageItem, PassageClientItem, McqResponse> = {
  id: "passage",
  tracks: ["receptive"],
  modality: { prompt: "text", answer: "choice" },

  appliesTo: (c) => c.passage !== undefined,

  // Shuffled so a Retry of the same question doesn't keep the answer's position.
  generate(target) {
    const p = target.passage;
    if (!p) return null;
    const choices = shuffle(p.choices);
    return {
      id: crypto.randomUUID(),
      lemmaId: target.lemmaId,
      questionId: p.questionId,
      passage: p.passage,
      target: p.target,
      question: p.question,
      choices,
      correctIndex: choices.indexOf(p.choices[p.correctIndex]),
    };
  },

  toClient: (item) => ({
    id: item.id,
    kind: "passage",
    passage: item.passage,
    target: item.target,
    question: item.question,
    choices: item.choices,
  }),

  grade: (item, response) =>
    response.choiceIndex === item.correctIndex ? Rating.Good : Rating.Again,
};

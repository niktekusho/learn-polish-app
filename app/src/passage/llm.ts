import { z } from "zod";
import type { CallSpec, ChoiceQuestion } from "#/llm/call";
import { parseJsonOutput } from "#/llm/json";

export interface PassageQuestionRequest {
  passage: string;
  lemma: string;
  target: string; // the lemma's surface form in the passage
}

/** One question a learner answers only by understanding the target word in the passage. */
export const passageQuestion: CallSpec<PassageQuestionRequest, ChoiceQuestion> = {
  name: "passage-question",
  tier: "gloss",
  prompt: (req) =>
    "Sei un insegnante di polacco. Ecco un breve testo polacco per uno studente " +
    "italiano principiante. Scrivi UNA domanda a scelta multipla IN ITALIANO a cui " +
    `si può rispondere solo capendo la parola «${req.target}» (lemma: ${req.lemma}) ` +
    "in questo contesto. Non tradurre né citare quella parola nella domanda. 3 o 4 " +
    "risposte in italiano, tutte diverse, di cui ESATTAMENTE una corretta secondo il " +
    "testo. Rispondi SOLO con JSON valido, senza testo attorno, nel formato: " +
    '{"question":"...","choices":["...","...","..."],"correctIndex":0}\n\n' +
    `Testo:\n${req.passage}`,
  parse: (text) => {
    const q = parseJsonOutput(
      text,
      "passage question",
      z.object({
        question: z.string().trim().min(1),
        choices: z.array(z.string().trim().min(1)).min(3).max(4),
        correctIndex: z.number().int().min(0),
      }),
    );
    if (q.correctIndex >= q.choices.length) {
      throw new Error(`passage correctIndex ${q.correctIndex} out of range`);
    }
    if (new Set(q.choices).size !== q.choices.length) {
      throw new Error("passage question has duplicate choices");
    }
    return q;
  },
  stub: (req) => ({
    question: `Domanda stub su «${req.target}»?`,
    choices: ["Risposta giusta (stub)", "Distrattore A", "Distrattore B"],
    correctIndex: 0,
  }),
};

import { z } from "zod";
import type { CallSpec, ChoiceQuestion } from "#/llm/call";
import { parseJsonOutput } from "#/llm/json";

export interface ComprehensionRequest {
  text: string; // full text content
}

export interface ComprehensionResult {
  questions: ChoiceQuestion[]; // 1–10, LLM picks the count
}

const comprehensionResponse = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().trim().min(1),
        choices: z.array(z.string().trim().min(1)).min(3).max(4),
        correctIndex: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(10),
});

/**
 * ONE call generates all the comprehension questions for a text. Italian questions
 * and choices isolate text comprehension from question comprehension at sub-A1.
 */
export const comprehension: CallSpec<ComprehensionRequest, ComprehensionResult> = {
  name: "comprehension",
  tier: "gloss",
  // The model picks the question count (1–10) proportional to text length: no
  // server-side length math.
  prompt: (req) =>
    "Sei un insegnante di polacco. Verifica se uno studente italiano ha capito " +
    "il testo polacco qui sotto. Scrivi domande a scelta multipla IN ITALIANO " +
    "sul contenuto del testo. Scegli tu tra 1 e 10 domande in proporzione alla " +
    "lunghezza del testo (testo brevissimo ≈ 1-2, testo lungo massimo 10). " +
    "Ogni domanda ha 3 o 4 risposte in italiano, di cui ESATTAMENTE una " +
    "corretta secondo il testo; i distrattori devono essere plausibili ma " +
    "chiaramente sbagliati. Rispondi SOLO con JSON valido, senza testo attorno, " +
    'nel formato: {"questions":[{"question":"...","choices":["...","...","..."],"correctIndex":0}]}\n\n' +
    `Testo:\n${req.text}`,
  parse: (text) => {
    const parsed = parseJsonOutput(text, "comprehension", comprehensionResponse);
    for (const q of parsed.questions) {
      if (q.correctIndex >= q.choices.length) {
        throw new Error(
          `comprehension correctIndex ${q.correctIndex} out of range (${q.choices.length} choices)`,
        );
      }
    }
    return parsed;
  },
  stub: (req) => ({
    questions: [
      {
        question: `Domanda stub sul testo (${req.text.length} caratteri)?`,
        choices: ["Risposta giusta (stub)", "Distrattore A", "Distrattore B"],
        correctIndex: 0,
      },
    ],
  }),
};

import type { AnalyzeResponse } from "#/import/sidecar";
import type { LevelFeedback } from "./llm";

const CONTENT_POS = new Set(["NOUN", "VERB", "ADJ", "ADV"]);
const LETTER = /\p{L}/u;

/** Distinct content lemmas of `analysis` missing from `known`, and their share of all. */
export function levelOf(analysis: AnalyzeResponse, known: Set<string>): LevelFeedback {
  const lemmas = new Set(
    analysis.sentences.flatMap((s) =>
      s.tokens.filter((t) => CONTENT_POS.has(t.pos)).map((t) => t.lemma.toLowerCase()),
    ),
  );
  const newWords = [...lemmas].filter((l) => !known.has(l));
  return { share: lemmas.size === 0 ? 0 : newWords.length / lemmas.size, newWords };
}

export interface EpisodeMetrics {
  words: number;
  sentences: number;
  avgSentenceWords: number;
  // Distinct word lemmas / words: low when the text repeats the same words.
  lemmaVariety: number;
  // Sentences opening with the same two words as an earlier sentence / sentences.
  repeatedOpenings: number;
  newShare: number;
}

/** Length, repetition and level of a generated text, from its analysis alone. */
export function episodeMetrics(analysis: AnalyzeResponse, known: Set<string>): EpisodeMetrics {
  const sentences = analysis.sentences
    .map((s) => s.tokens.filter((t) => !t.is_space && LETTER.test(t.surface)))
    .filter((words) => words.length > 0);
  const words = sentences.flat();
  const seen = new Set<string>();
  let repeated = 0;
  for (const s of sentences) {
    const opening = s
      .slice(0, 2)
      .map((t) => t.surface.toLowerCase())
      .join(" ");
    if (seen.has(opening)) repeated++;
    seen.add(opening);
  }
  const ratio = (x: number, of: number) => (of === 0 ? 0 : x / of);
  return {
    words: words.length,
    sentences: sentences.length,
    avgSentenceWords: ratio(words.length, sentences.length),
    lemmaVariety: ratio(new Set(words.map((t) => t.lemma.toLowerCase())).size, words.length),
    repeatedOpenings: ratio(repeated, sentences.length),
    newShare: levelOf(analysis, known).share,
  };
}

import { expect, test } from "vitest";
import type { AnalyzeResponse } from "#/import/sidecar";
import { episodeMetrics } from "./metrics";

const tok = (surface: string, pos = "NOUN") => ({
  surface,
  lemma: surface.toLowerCase(),
  pos,
  tags: [],
  is_space: false,
});
const analysis = (...sentences: string[][]): AnalyzeResponse => ({
  sentences: sentences.map((words) => ({
    tokens: [...words.map((w) => tok(w)), tok(".", "PUNCT")],
  })),
});

test("a text repeating its sentence opening and words scores low variety and high repetition", () => {
  const m = episodeMetrics(
    analysis(["Ala", "ma", "kota"], ["Ala", "ma", "psa"], ["Ala", "ma", "kota"]),
    new Set(["ala", "ma", "kota"]),
  );
  expect(m).toMatchObject({ words: 9, sentences: 3, avgSentenceWords: 3 });
  expect(m.repeatedOpenings).toBeCloseTo(2 / 3);
  expect(m.lemmaVariety).toBeCloseTo(4 / 9);
  expect(m.newShare).toBeCloseTo(1 / 4);
});

test("an empty text has zero metrics", () => {
  expect(episodeMetrics({ sentences: [] }, new Set())).toMatchObject({ words: 0, sentences: 0 });
});

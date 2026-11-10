import { expect, test } from "vitest";
import { type ReportReviewItem, reportReview } from "./llm";

const item: ReportReviewItem = {
  lemma: "tylko",
  pos: "ADV",
  note: "è sbagliata",
  gloss: "ma anche",
  manual: false,
  contextBound: false,
  senses: [{ index: 0, gloss: "only", italian: "solo" }],
  sentences: ["Mam tylko kota."],
  names: [],
  previous: null,
};
const items = (n: number) => Array.from({ length: n }, () => item);

test("report review: a malformed item is null, a wrong item count fails the call", () => {
  const ok = { gloss: { sense: 0 }, contextBound: true, reason: "Dipende dalla frase." };
  const out = JSON.stringify({ reviews: [ok, { gloss: "replace", contextBound: false }] });
  expect(reportReview.parse(out, items(2))).toEqual([{ ...ok, names: [] }, null]);
  expect(() => reportReview.parse(JSON.stringify({ reviews: [ok] }), items(2))).toThrow(/2/);
});

test("report review: Name decisions are candidate indices, anything else makes the item null", () => {
  const ok = { gloss: "keep", contextBound: false, names: [0, 2], reason: "Nome del drago." };
  const bad = [-1, 1.5, "0"].map((index) => ({ ...ok, names: [index] }));
  const out = JSON.stringify({ reviews: [ok, ...bad] });
  expect(reportReview.parse(out, items(4))).toEqual([ok, null, null, null]);
});

test("report review: the prompt numbers each item with its note and senses", () => {
  const prompt = reportReview.prompt(items(1));
  expect(prompt).toContain("1. Lemma: tylko (ADV)");
  expect(prompt).toContain("Nota dello studente: «è sbagliata»");
  expect(prompt).toContain("0. only (solo)");
});

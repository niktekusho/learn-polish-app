import { expect, test } from "vitest";
import { occurrenceGloss, senseGloss, sentenceGloss } from "./llm";

const robic = { lemma: "robić", pos: "VERB", sentence: "Robię obiad w kuchni." };

test("sentence gloss: trims a valid one-liner", () => {
  expect(sentenceGloss.parse("  fare\n", robic)).toBe("fare");
});

test("sentence gloss: rejects empty output", () => {
  expect(() => sentenceGloss.parse("   \n", robic)).toThrow();
});

test("sentence gloss: rejects a rambling response (too long)", () => {
  expect(() => sentenceGloss.parse("Ecco la glossa: ".repeat(10), robic)).toThrow();
});

test("sentence gloss: drops an echoed surface form before the arrow", () => {
  const swoj = { lemma: "swój", pos: "DET", sentence: "Mają swoich przyjaciół." };
  expect(sentenceGloss.parse("swoich → proprio\n", swoj)).toBe("proprio");
});

test("sentence gloss: the prompt names the lemma and its sentence", () => {
  const prompt = sentenceGloss.prompt(robic);
  expect(prompt).toContain("Lemma: robić");
  expect(prompt).toContain("Frase: Robię obiad w kuchni.");
});

const zamek = {
  lemma: "zamek",
  pos: "NOUN",
  surface: "Zamek",
  sentence: "Zamek w drzwiach.",
  senses: [
    { index: 0, gloss: "castle" },
    { index: 1, gloss: "lock" },
  ],
};
const oneSense = { ...zamek, senses: [{ index: 0, gloss: "castle" }] };

const good = JSON.stringify({
  translations: [
    { index: 0, italian: "castello" },
    { index: 1, italian: "serratura" },
  ],
  bestIndex: 1,
  occurrence: { index: 1 },
});

test("sense gloss: parses plain JSON", () => {
  const res = senseGloss.parse(good, zamek);
  expect(res.bestIndex).toBe(1);
  expect(res.translations).toHaveLength(2);
  expect(res.occurrence).toEqual({ index: 1 });
});

test("sense gloss: parses a free-text occurrence with its fixed flag and note", () => {
  const free = JSON.stringify({
    translations: [{ index: 0, italian: "chiedere a qualcuno" }],
    bestIndex: 0,
    occurrence: { italian: "vorrei", fixed: true, note: "ordinando, cortese" },
  });
  expect(senseGloss.parse(free, oneSense).occurrence).toEqual({
    italian: "vorrei",
    fixed: true,
    note: "ordinando, cortese",
  });
});

test("sense gloss: throws on an occurrence sense index out of range", () => {
  const bad = JSON.stringify({
    translations: [{ index: 0, italian: "castello" }],
    bestIndex: 0,
    occurrence: { index: 4 },
  });
  expect(() => senseGloss.parse(bad, oneSense)).toThrow(/occurrence index 4 out of range/);
});

test("sense gloss: strips markdown fences", () => {
  const fenced = "```json\n" + good + "\n```";
  expect(senseGloss.parse(fenced, zamek).bestIndex).toBe(1);
});

test("sense gloss: throws on out-of-range translation index", () => {
  expect(() => senseGloss.parse(good, oneSense)).toThrow(/out of range/);
});

test("sense gloss: throws when bestIndex is not among translations", () => {
  const bad = JSON.stringify({
    translations: [{ index: 0, italian: "castello" }],
    bestIndex: 3,
    occurrence: { index: 0 },
  });
  const fiveSenses = { ...zamek, senses: [0, 1, 2, 3, 4].map((index) => ({ index, gloss: "g" })) };
  expect(() => senseGloss.parse(bad, fiveSenses)).toThrow(/not among/);
});

test("sense gloss: throws on junk output", () => {
  expect(() => senseGloss.parse("Ecco la traduzione: ...", zamek)).toThrow(/not JSON/);
  expect(() => senseGloss.parse('{"translations":[]}', zamek)).toThrow();
});

test("sense gloss: the prompt lists senses with their indexes and demands JSON", () => {
  const prompt = senseGloss.prompt(zamek);
  expect(prompt).toContain("0. castle");
  expect(prompt).toContain("1. lock");
  expect(prompt).toContain("bestIndex");
});

const doReq = {
  lemma: "do",
  pos: "ADP",
  surface: "do",
  sentence: "Marco idzie do piekarni.",
  senses: [
    { index: 0, gloss: "to, towards", italian: "a" },
    { index: 1, gloss: "for", italian: "per" },
  ],
};

test("occurrence: parses a sense pointer or free text", () => {
  expect(occurrenceGloss.parse('{"index":1}', doReq)).toEqual({ index: 1 });
  expect(occurrenceGloss.parse('{"italian":"in","fixed":false,"note":null}', doReq)).toEqual({
    italian: "in",
    fixed: false,
    note: null,
  });
  expect(() => occurrenceGloss.parse('{"index":0}', { ...doReq, senses: [] })).toThrow(
    /out of range/,
  );
  expect(() => occurrenceGloss.parse('{"italian":""}', doReq)).toThrow();
});

test("occurrence: the prompt names the surface and lists senses with their Italian", () => {
  const prompt = occurrenceGloss.prompt(doReq);
  expect(prompt).toContain("Forma: do");
  expect(prompt).toContain("1. for (per)");
});

test("occurrence: the stub points to the first sense, or gives free text when there is none", () => {
  expect(occurrenceGloss.stub(doReq)).toEqual({ index: 0 });
  expect(occurrenceGloss.stub({ ...doReq, senses: [] })).toEqual({
    italian: "«do»: occorrenza stub",
    fixed: false,
    note: null,
  });
});

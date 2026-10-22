import { expect, test } from "vitest";
import {
  buildComprehensionPrompt,
  buildCorrectionPrompt,
  buildProofreadPrompt,
  buildOccurrencePrompt,
  buildSenseGlossPrompt,
  parseComprehensionJson,
  parseCorrectedText,
  parseEpisodeText,
  parseMweCheckJson,
  parseOccurrenceJson,
  parsePassageJson,
  parsePassageQuestionJson,
  parsePremisesJson,
  parseProofreadJson,
  parseSenseGlossJson,
  parseStoryOutlineJson,
} from "./provider";

const good = JSON.stringify({
  translations: [
    { index: 0, italian: "castello" },
    { index: 1, italian: "serratura" },
  ],
  bestIndex: 1,
  occurrence: { index: 1 },
});

test("parses plain JSON", () => {
  const res = parseSenseGlossJson(good, 2);
  expect(res.bestIndex).toBe(1);
  expect(res.translations).toHaveLength(2);
  expect(res.occurrence).toEqual({ index: 1 });
});

test("parses a free-text occurrence with its fixed flag and note", () => {
  const free = JSON.stringify({
    translations: [{ index: 0, italian: "chiedere a qualcuno" }],
    bestIndex: 0,
    occurrence: { italian: "vorrei", fixed: true, note: "ordinando, cortese" },
  });
  expect(parseSenseGlossJson(free, 1).occurrence).toEqual({
    italian: "vorrei",
    fixed: true,
    note: "ordinando, cortese",
  });
});

test("throws on an occurrence sense index out of range", () => {
  const bad = JSON.stringify({
    translations: [{ index: 0, italian: "castello" }],
    bestIndex: 0,
    occurrence: { index: 4 },
  });
  expect(() => parseSenseGlossJson(bad, 1)).toThrow(/occurrence index 4 out of range/);
});

test("occurrence call: parses a sense pointer or free text", () => {
  expect(parseOccurrenceJson('{"index":1}', 2)).toEqual({ index: 1 });
  expect(parseOccurrenceJson('{"italian":"in","fixed":false,"note":null}', 2)).toEqual({
    italian: "in",
    fixed: false,
    note: null,
  });
  expect(() => parseOccurrenceJson('{"index":0}', 0)).toThrow(/out of range/);
  expect(() => parseOccurrenceJson('{"italian":""}', 2)).toThrow();
});

test("occurrence prompt names the surface and lists senses with their Italian", () => {
  const prompt = buildOccurrencePrompt({
    lemma: "do",
    pos: "ADP",
    surface: "do",
    sentence: "Marco idzie do piekarni.",
    senses: [
      { index: 0, gloss: "to, towards", italian: "a" },
      { index: 1, gloss: "for", italian: "per" },
    ],
  });
  expect(prompt).toContain("Forma: do");
  expect(prompt).toContain("1. for (per)");
});

test("strips markdown fences", () => {
  const fenced = "```json\n" + good + "\n```";
  expect(parseSenseGlossJson(fenced, 2).bestIndex).toBe(1);
});

test("throws on out-of-range translation index", () => {
  expect(() => parseSenseGlossJson(good, 1)).toThrow(/out of range/);
});

test("throws when bestIndex is not among translations", () => {
  const bad = JSON.stringify({
    translations: [{ index: 0, italian: "castello" }],
    bestIndex: 3,
    occurrence: { index: 0 },
  });
  expect(() => parseSenseGlossJson(bad, 5)).toThrow(/not among/);
});

test("throws on junk output", () => {
  expect(() => parseSenseGlossJson("Ecco la traduzione: ...", 2)).toThrow(/not JSON/);
  expect(() => parseSenseGlossJson('{"translations":[]}', 2)).toThrow();
});

// --- Comprehension checks ----------------------------------------------------

const goodCheck = JSON.stringify({
  questions: [
    { question: "Di cosa parla il testo?", choices: ["gatti", "cani", "case"], correctIndex: 0 },
  ],
});

test("comprehension: parses plain JSON and strips fences", () => {
  expect(parseComprehensionJson(goodCheck).questions).toHaveLength(1);
  const fenced = "```json\n" + goodCheck + "\n```";
  expect(parseComprehensionJson(fenced).questions[0].correctIndex).toBe(0);
});

test("comprehension: throws on junk, empty questions, bad choice counts", () => {
  expect(() => parseComprehensionJson("Ecco le domande: ...")).toThrow(/not JSON/);
  expect(() => parseComprehensionJson('{"questions":[]}')).toThrow();
  const twoChoices = JSON.stringify({
    questions: [{ question: "Q?", choices: ["a", "b"], correctIndex: 0 }],
  });
  expect(() => parseComprehensionJson(twoChoices)).toThrow();
  const fiveChoices = JSON.stringify({
    questions: [{ question: "Q?", choices: ["a", "b", "c", "d", "e"], correctIndex: 0 }],
  });
  expect(() => parseComprehensionJson(fiveChoices)).toThrow();
});

test("comprehension: throws on more than 10 questions", () => {
  const many = JSON.stringify({
    questions: Array.from({ length: 11 }, (_, i) => ({
      question: `Q${i}?`,
      choices: ["a", "b", "c"],
      correctIndex: 0,
    })),
  });
  expect(() => parseComprehensionJson(many)).toThrow();
});

test("comprehension: throws on out-of-range correctIndex", () => {
  const bad = JSON.stringify({
    questions: [{ question: "Q?", choices: ["a", "b", "c"], correctIndex: 3 }],
  });
  expect(() => parseComprehensionJson(bad)).toThrow(/out of range/);
});

test("comprehension: prompt embeds the text and demands JSON", () => {
  const prompt = buildComprehensionPrompt({ text: "Ala ma kota." });
  expect(prompt).toContain("Ala ma kota.");
  expect(prompt).toContain("correctIndex");
});

test("prompt lists senses with their indexes and demands JSON", () => {
  const prompt = buildSenseGlossPrompt({
    lemma: "zamek",
    pos: "NOUN",
    surface: "Zamek",
    sentence: "Zamek w drzwiach.",
    senses: [
      { index: 0, gloss: "castle" },
      { index: 1, gloss: "lock" },
    ],
  });
  expect(prompt).toContain("0. castle");
  expect(prompt).toContain("1. lock");
  expect(prompt).toContain("bestIndex");
});

const premise = { title: "Il gatto", genre: "giallo", hook: "Un gatto scompare." };

test("premises: parses three, strips fences, rejects fewer", () => {
  const three = JSON.stringify({ premises: [premise, premise, premise] });
  expect(parsePremisesJson("```json\n" + three + "\n```")).toHaveLength(3);
  expect(() => parsePremisesJson(JSON.stringify({ premises: [premise] }))).toThrow();
  expect(() => parsePremisesJson("ecco le premesse")).toThrow(/not JSON/);
});

test("outline: needs at least one episode beat", () => {
  const outline = { plot: "Trama", characters: ["Ala"], beats: ["inizio", "fine"] };
  expect(parseStoryOutlineJson(JSON.stringify(outline)).beats).toHaveLength(2);
  expect(() => parseStoryOutlineJson(JSON.stringify({ ...outline, beats: [] }))).toThrow();
});

test("episode text: trims fences, rejects empty and runaway output", () => {
  expect(parseEpisodeText("```\nAla ma kota.\n```")).toBe("Ala ma kota.");
  expect(() => parseEpisodeText("  ")).toThrow();
  expect(() => parseEpisodeText("a".repeat(5000))).toThrow();
});

test("generated passage: the target must appear in the passage", () => {
  const ok = { passage: "Idę do sklepu.", target: "do" };
  expect(parsePassageJson(JSON.stringify(ok))).toEqual(ok);
  expect(() => parsePassageJson(JSON.stringify({ ...ok, target: "za" }))).toThrow(/not in/);
  // Inside another word is not an occurrence.
  const inside = { passage: "Idę domu.", target: "do" };
  expect(() => parsePassageJson(JSON.stringify(inside))).toThrow(/not in/);
  const accented = { passage: "Żółw śpi.", target: "żółw" };
  expect(parsePassageJson(JSON.stringify(accented))).toEqual(accented);
});

test("passage question: 3–4 distinct choices with an in-range answer", () => {
  const q = { question: "Dove?", choices: ["a", "b", "c"], correctIndex: 2 };
  expect(parsePassageQuestionJson(JSON.stringify(q))).toEqual(q);
  expect(() => parsePassageQuestionJson(JSON.stringify({ ...q, correctIndex: 3 }))).toThrow();
  expect(() => parsePassageQuestionJson(JSON.stringify({ ...q, choices: ["a", "b"] }))).toThrow();
  expect(() =>
    parsePassageQuestionJson(JSON.stringify({ ...q, choices: ["a", "a", "c"] })),
  ).toThrow(/duplicate/);
});

test("MWE check: one verdict per item, in order", () => {
  expect(parseMweCheckJson(JSON.stringify({ keep: [true, false] }), 2)).toEqual([true, false]);
  expect(parseMweCheckJson('```json\n{"keep":[false]}\n```', 1)).toEqual([false]);
  expect(() => parseMweCheckJson(JSON.stringify({ keep: [true] }), 2)).toThrow(/2/);
  expect(() => parseMweCheckJson(JSON.stringify({ keep: ["yes"] }), 1)).toThrow();
});

test("proofread: parses flagged spans, an empty list is valid", () => {
  const text = "Duża torta jest gotowa.";
  const errors = [{ span: "Duża torta", reason: "tort è maschile" }];
  expect(parseProofreadJson(JSON.stringify({ errors }), text)).toEqual(errors);
  expect(parseProofreadJson('```json\n{"errors":[]}\n```', text)).toEqual([]);
  expect(() => parseProofreadJson(JSON.stringify({ errors: [{ span: "x" }] }), text)).toThrow();
});

test("proofread: a span missing from the text is junk", () => {
  const errors = [{ span: "duży tort", reason: "?" }];
  expect(() => parseProofreadJson(JSON.stringify({ errors }), "Duża torta.")).toThrow(/not in/);
});

test("proofread and correction prompts carry the text and every flagged span", () => {
  const text = "Duża torta jest gotowa.";
  expect(buildProofreadPrompt(text)).toContain(text);
  const prompt = buildCorrectionPrompt(text, [
    { span: "torta", reason: "not in the home dictionary" },
  ]);
  expect(prompt).toContain(text);
  expect(prompt).toContain("«torta»: not in the home dictionary");
});

test("corrected text: trims fences, rejects empty output", () => {
  expect(parseCorrectedText("```\nDuży tort.\n```")).toBe("Duży tort.");
  expect(() => parseCorrectedText(" ")).toThrow();
});

import { describe, expect, test } from "vitest";
import {
  buildComprehensionPrompt,
  buildCorrectionPrompt,
  buildEpisodePrompt,
  buildPremisesPrompt,
  buildProofreadPrompt,
  buildOccurrencePrompt,
  buildSenseGlossPrompt,
  parseComprehensionJson,
  parseCorrectedText,
  parseDebriefJson,
  parseEpisodeText,
  parseMweCheckJson,
  parseOccurrenceJson,
  parsePassageQuestionJson,
  parsePremisesJson,
  parseProofreadJson,
  parseReportReviewJson,
  parseSceneJson,
  parseSenseGlossJson,
  parseStoryOutlineJson,
  type SceneRequest,
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

test("report review: a malformed item is null, a wrong item count fails the call", () => {
  const ok = { gloss: { sense: 0 }, contextBound: true, reason: "Dipende dalla frase." };
  const out = JSON.stringify({ reviews: [ok, { gloss: "replace", contextBound: false }] });
  expect(parseReportReviewJson(out, 2)).toEqual([{ ...ok, names: [] }, null]);
  expect(() => parseReportReviewJson(JSON.stringify({ reviews: [ok] }), 2)).toThrow(/2/);
});

test("report review: Name decisions are candidate indices, anything else makes the item null", () => {
  const ok = { gloss: "keep", contextBound: false, names: [0, 2], reason: "Nome del drago." };
  const bad = [-1, 1.5, "0"].map((index) => ({ ...ok, names: [index] }));
  const out = JSON.stringify({ reviews: [ok, ...bad] });
  expect(parseReportReviewJson(out, 4)).toEqual([ok, null, null, null]);
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

const EPISODE = {
  premise: { title: "Il gatto di Ala", genre: "quotidiano", hook: "Ala cerca il gatto." },
  outline: {
    plot: "Ala cerca Burek.",
    characters: ["Ala"],
    beats: ["episodio 1: Burek sparisce", "Episodio 2 : Ala chiede aiuto", "lo trovano"],
  },
  episodeNumber: 2,
  totalEpisodes: 3,
  newShare: 0.15,
};

test("episode prompt numbers each plan line once", () => {
  const prompt = buildEpisodePrompt({ ...EPISODE, previous: "Burek nie ma." });
  expect(prompt).toContain("1. Burek sparisce\n2. Ala chiede aiuto\n3. lo trovano");
  expect(prompt).not.toMatch(/episodio \d+ ?:/i);
});

test("episode prompt carries the previous episode, or says there is none", () => {
  expect(buildEpisodePrompt({ ...EPISODE, previous: "Burek nie ma." })).toContain(
    "Episodio precedente (1):\nBurek nie ma.",
  );
  expect(buildEpisodePrompt({ ...EPISODE, episodeNumber: 1, previous: null })).toContain(
    "primo episodio",
  );
});

test("premises prompt asks to avoid the genres of past stories", () => {
  expect(buildPremisesPrompt(["fantasy", "giallo"])).toContain("fantasy, giallo");
  expect(buildPremisesPrompt([])).not.toContain("Evita");
});

describe("parseSceneJson", () => {
  const req: SceneRequest = {
    episode: "Ala ma kota.",
    characters: ["Ala – una ragazza", "Pan Jan – il vicino"],
    profile: { name: "Marco", job: "", city: "", partner: "", hobbies: "" },
    dueLemmas: [],
    voices: [
      { id: "gosia", label: "Voce femminile" },
      { id: "bass", label: "Voce maschile" },
    ],
  };
  const reply = {
    character: 1,
    scene: "Sulle scale.",
    steps: ["Saluta", "Chiedi del gatto"],
    roleFacts: null,
    opening: {
      line: "Dzień dobry!",
      italian: "Buongiorno!",
      hint: ["dzień"],
      modelLine: "Dzień dobry.",
    },
    voices: ["gosia", "bass"],
  };

  test("accepts a scene whose character and voices are known keys", () => {
    expect(parseSceneJson(JSON.stringify(reply), req)).toEqual(reply);
  });

  test("rejects a character outside the outline", () => {
    expect(() => parseSceneJson(JSON.stringify({ ...reply, character: 2 }), req)).toThrow(/range/);
  });

  test("rejects a voice outside the catalog, or one missing", () => {
    for (const voices of [["gosia", "nobody"], ["gosia"]]) {
      expect(() => parseSceneJson(JSON.stringify({ ...reply, voices }), req)).toThrow(/catalog/);
    }
  });

  test("ignores voices when none were asked", () => {
    const scene = parseSceneJson(JSON.stringify(reply), { ...req, voices: null });
    expect(scene.voices).toBeNull();
  });

  test("rejects a Goal of one step or of five", () => {
    for (const steps of [["a"], ["a", "b", "c", "d", "e"]]) {
      expect(() => parseSceneJson(JSON.stringify({ ...reply, steps }), req)).toThrow();
    }
  });
});

describe("parseDebriefJson", () => {
  const said = ["Poproszę dwa bułki.", "Dwa bułki i jeden kawa, proszę!"];
  const correction = (n: number) => ({
    said: "dwa bułki",
    corrected: "dwie bułki",
    italian: `Con i nomi femminili il due è «dwie» (${n}).`,
  });
  const reply = (corrections: unknown[]) => JSON.stringify({ corrections });

  test("keeps the corrections in the model's order, recurring patterns first", () => {
    const kawa = { said: "Jeden kawa,", corrected: "jedną kawę", italian: "Accusativo." };
    expect(parseDebriefJson(reply([correction(1), kawa]), said)).toEqual([correction(1), kawa]);
  });

  test("drops a correction of words the learner never said", () => {
    const invented = { said: "trzy bułki", corrected: "trzy bułki", italian: "x" };
    expect(parseDebriefJson(reply([invented, correction(1)]), said)).toEqual([correction(1)]);
  });

  test("rejects a reply without a corrections list", () => {
    expect(() => parseDebriefJson("Ottimo lavoro!", said)).toThrow(/debrief/);
    expect(() => parseDebriefJson(JSON.stringify({ items: [] }), said)).toThrow();
  });
});

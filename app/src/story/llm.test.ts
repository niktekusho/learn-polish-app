import { expect, test } from "vitest";
import { episode, outline, premises } from "./llm";

const premise = { title: "Il gatto", genre: "giallo", hook: "Un gatto scompare." };

test("premises: parses three, strips fences, rejects fewer", () => {
  const three = JSON.stringify({ premises: [premise, premise, premise] });
  expect(premises.parse("```json\n" + three + "\n```", [])).toHaveLength(3);
  expect(() => premises.parse(JSON.stringify({ premises: [premise] }), [])).toThrow();
  expect(() => premises.parse("ecco le premesse", [])).toThrow(/not JSON/);
});

test("premises prompt asks to avoid the genres of past stories", () => {
  expect(premises.prompt(["fantasy", "giallo"])).toContain("fantasy, giallo");
  expect(premises.prompt([])).not.toContain("Evita");
});

test("outline: needs at least one episode beat", () => {
  const plan = { plot: "Trama", characters: ["Ala"], beats: ["inizio", "fine"] };
  expect(outline.parse(JSON.stringify(plan), premise).beats).toHaveLength(2);
  expect(() => outline.parse(JSON.stringify({ ...plan, beats: [] }), premise)).toThrow();
});

const EPISODE = {
  premise: { title: "Il gatto di Ala", genre: "quotidiano", hook: "Ala cerca il gatto." },
  outline: {
    plot: "Ala cerca Burek.",
    characters: ["Ala"],
    beats: ["episodio 1: Burek sparisce", "Episodio 2 : Ala chiede aiuto", "lo trovano"],
  },
  previous: "Burek nie ma.",
  episodeNumber: 2,
  totalEpisodes: 3,
  newShare: 0.15,
};

test("episode text: trims fences, rejects empty and runaway output", () => {
  expect(episode.parse("```\nAla ma kota.\n```", EPISODE)).toBe("Ala ma kota.");
  expect(() => episode.parse("  ", EPISODE)).toThrow();
  expect(() => episode.parse("a".repeat(5000), EPISODE)).toThrow();
});

test("episode prompt numbers each plan line once", () => {
  const prompt = episode.prompt(EPISODE);
  expect(prompt).toContain("1. Burek sparisce\n2. Ala chiede aiuto\n3. lo trovano");
  expect(prompt).not.toMatch(/episodio \d+ ?:/i);
});

test("episode prompt carries the previous episode, or says there is none", () => {
  expect(episode.prompt(EPISODE)).toContain("Episodio precedente (1):\nBurek nie ma.");
  expect(episode.prompt({ ...EPISODE, episodeNumber: 1, previous: null })).toContain(
    "primo episodio",
  );
});

test("the stub episode names its episode number", () => {
  expect(episode.stub(EPISODE)).toContain("odcinek 2");
});

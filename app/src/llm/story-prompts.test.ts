import { expect, test } from "vitest";
import { parseEpisodeText, parsePremisesJson, parseStoryOutlineJson } from "./provider";

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

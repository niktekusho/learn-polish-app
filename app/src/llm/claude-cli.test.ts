import { expect, test } from "vitest";
import { parseGloss } from "./provider";
import { ClaudeCliProvider } from "./claude-cli";

const req = { lemma: "robić", pos: "VERB", sentence: "Robię obiad w kuchni." };

test("parseGloss trims a valid one-liner", () => {
  expect(parseGloss("  fare\n")).toBe("fare");
});

test("parseGloss rejects empty output", () => {
  expect(() => parseGloss("   \n")).toThrow();
});

test("parseGloss rejects a rambling response (too long)", () => {
  expect(() => parseGloss("Ecco la glossa: ".repeat(10))).toThrow();
});

test("provider returns the parsed CLI stdout", async () => {
  const provider = new ClaudeCliProvider(async () => "fare\n");
  expect(await provider.gloss(req)).toBe("fare");
});

test("provider bubbles a CLI failure so nothing gets cached", async () => {
  const provider = new ClaudeCliProvider(async () => {
    throw new Error("claude exited 1");
  });
  await expect(provider.gloss(req)).rejects.toThrow();
});

test("provider drops an echoed surface form before the arrow", async () => {
  const provider = new ClaudeCliProvider(async () => "swoich → proprio\n");
  const swoj = { lemma: "swój", pos: "DET", sentence: "Mają swoich przyjaciół." };
  expect(await provider.gloss(swoj)).toBe("proprio");
});

test("story calls are tagged so they can use STORY_MODEL", async () => {
  const tasks: string[] = [];
  const provider = new ClaudeCliProvider(async (_prompt, task) => {
    tasks.push(task);
    return task === "story" ? "Ala ma kota." : "fare";
  });
  await provider.gloss(req);
  await provider.episode({
    premise: { title: "t", genre: "g", hook: "h" },
    outline: { plot: "p", characters: [], beats: ["b"] },
    previous: [],
    episodeNumber: 1,
    totalEpisodes: 1,
    knownLemmas: [],
  });
  expect(tasks).toEqual(["gloss", "story"]);
});

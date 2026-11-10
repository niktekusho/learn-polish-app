import { describe, expect, test } from "vitest";
import { type DebriefRequest, debrief, scene, type SceneRequest } from "./llm";

describe("scene", () => {
  const req: SceneRequest = {
    episode: "Ala ma kota.",
    characters: ["Ala – una ragazza", "Pan Jan – il vicino"],
    profile: { name: "Marco", job: "", city: "", partner: "", hobbies: "" },
    dueLemmas: [],
    memory: [[], []],
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
    expect(scene.parse(JSON.stringify(reply), req)).toEqual(reply);
  });

  test("rejects a character outside the outline", () => {
    expect(() => scene.parse(JSON.stringify({ ...reply, character: 2 }), req)).toThrow(/range/);
  });

  test("rejects a voice outside the catalog, or one missing", () => {
    for (const voices of [["gosia", "nobody"], ["gosia"]]) {
      expect(() => scene.parse(JSON.stringify({ ...reply, voices }), req)).toThrow(/catalog/);
    }
  });

  test("ignores voices when none were asked", () => {
    const result = scene.parse(JSON.stringify(reply), { ...req, voices: null });
    expect(result.voices).toBeNull();
  });

  test("rejects a Goal of one step or of five", () => {
    for (const steps of [["a"], ["a", "b", "c", "d", "e"]]) {
      expect(() => scene.parse(JSON.stringify({ ...reply, steps }), req)).toThrow();
    }
  });
});

describe("debrief", () => {
  const said = ["Poproszę dwa bułki.", "Dwa bułki i jeden kawa, proszę!"];
  const req: DebriefRequest = {
    transcript: [
      { speaker: "character", text: "Dzień dobry! Dwa bułki?" },
      ...said.map((text) => ({ speaker: "learner" as const, text })),
    ],
    character: "Pani Ewa – la fornaia",
    memory: [],
  };
  const correction = (n: number) => ({
    said: "dwa bułki",
    corrected: "dwie bułki",
    italian: `Con i nomi femminili il due è «dwie» (${n}).`,
  });
  const reply = (corrections: unknown[], memory: string[] = []) =>
    JSON.stringify({ corrections, memory });

  test("keeps the corrections in the model's order, recurring patterns first", () => {
    const kawa = { said: "Jeden kawa,", corrected: "jedną kawę", italian: "Accusativo." };
    expect(debrief.parse(reply([correction(1), kawa]), req).corrections).toEqual([
      correction(1),
      kawa,
    ]);
  });

  test("drops a correction of words only the character said, or nobody said", () => {
    const invented = { said: "trzy bułki", corrected: "trzy bułki", italian: "x" };
    const theirs = { said: "Dzień dobry!", corrected: "Dzień dobry!", italian: "x" };
    expect(debrief.parse(reply([invented, theirs, correction(1)]), req).corrections).toEqual([
      correction(1),
    ]);
  });

  test("keeps at most 5 Character memory lines, in the model's order", () => {
    const memory = Array.from({ length: 7 }, (_, i) => `Ricordo ${i + 1}.`);
    expect(debrief.parse(reply([], memory), req).memory).toEqual(memory.slice(0, 5));
  });

  test("rejects a reply without a corrections list or a memory list", () => {
    expect(() => debrief.parse("Ottimo lavoro!", req)).toThrow(/debrief/);
    expect(() => debrief.parse(JSON.stringify({ items: [] }), req)).toThrow();
    expect(() => debrief.parse(JSON.stringify({ corrections: [] }), req)).toThrow();
  });
});

test("the stub scene opens the bakery script and gives each character a catalog voice", () => {
  const req: SceneRequest = {
    episode: "Ala ma kota.",
    characters: ["Ala", "Jan", "Ewa"],
    profile: { name: "Marco", job: "", city: "", partner: "", hobbies: "" },
    dueLemmas: [],
    memory: [[], [], []],
    voices: [
      { id: "gosia", label: "" },
      { id: "bass", label: "" },
    ],
  };
  const result = scene.stub(req);
  expect(result.opening.line).toBe("Dzień dobry! W czym mogę pomóc?");
  expect(result.voices).toEqual(["gosia", "bass", "gosia"]);
  expect(scene.stub({ ...req, voices: null }).voices).toBeNull();
});

test("the stub debrief corrects the first learner line and appends a memory line", () => {
  const req: DebriefRequest = {
    transcript: [
      { speaker: "character", text: "Dzień dobry!" },
      { speaker: "learner", text: "Poproszę bułka." },
    ],
    character: "Ewa",
    memory: ["Uno.", "Due.", "Tre.", "Quattro.", "Cinque."],
  };
  const result = debrief.stub(req);
  expect(result.corrections.map((c) => c.said)).toEqual(["Poproszę bułka."]);
  expect(result.memory).toEqual(["Due.", "Tre.", "Quattro.", "Cinque.", "Ricordo stub."]);
});

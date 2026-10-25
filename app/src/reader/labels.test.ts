import { expect, test } from "vitest";
import { caseOfForm, italianTags, posLabel } from "./labels";

test("Wiktionary tags read in Italian", () => {
  expect(italianTags(["third-person", "singular", "future"])).toBe(
    "terza persona singolare futuro",
  );
});

test("a qualified variety puts the qualifier after", () => {
  expect(italianTags(["alternative", "Middle", "Polish"])).toBe("variante polacco medio");
  expect(italianTags(["Eastern", "Galicia"])).toBe("Galizia orientale");
});

test("import error tags are hidden", () => {
  expect(italianTags(["error-unrecognized-form", "plural"])).toBe("plurale");
});

test("an unknown tag stays readable", () => {
  expect(italianTags(["some-new-tag"])).toBe("some new tag");
});

test("a form's case tag becomes its pill, the rest stay tags", () => {
  expect(caseOfForm(["genitive", "plural"])).toEqual({
    pill: { key: "gen", label: "genitivo" },
    rest: ["plural"],
  });
  expect(caseOfForm(["infinitive"])).toEqual({ pill: null, rest: ["infinitive"] });
});

test("part of speech reads in Italian for both the tagger and the dictionary", () => {
  expect(posLabel("NOUN")).toBe("sostantivo");
  expect(posLabel("adj")).toBe("aggettivo");
  expect(posLabel("XYZ")).toBe("XYZ");
});

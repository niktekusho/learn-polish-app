import { expect, test } from "vitest";
import { nameForm } from "./name";

test("an inflected Name shows base form, case and number", () => {
  expect(nameForm("Kasi", "Kasia", ["Case=Gen", "Number=Sing"])).toEqual({
    word: "Kasi",
    base: "Kasia",
    case: { key: "gen", label: "genitivo", polish: "dopełniacz" },
    number: "singolare",
  });
});

test("a nominative Name gets no label", () => {
  expect(nameForm("Kasia ", "Kasia", ["Case=Nom", "Number=Sing"])).toBeNull();
});

test("without tags, a surface that differs from the base is labelled without case", () => {
  expect(nameForm("Warszawie", "Warszawa", null)).toEqual({
    word: "Warszawie",
    base: "Warszawa",
    case: null,
    number: null,
  });
  expect(nameForm("Marco ", "Marco", null)).toBeNull();
});

test("an indeclinable Name tagged with a case gets no label", () => {
  expect(nameForm("Marco", "Marco", ["Case=Acc", "Number=Sing"])).toBeNull();
});

test("an oblique form the tagger calls nominative is labelled without case", () => {
  expect(nameForm("Kasi", "Kasia", ["Case=Nom", "Number=Sing"])?.case).toBeNull();
});

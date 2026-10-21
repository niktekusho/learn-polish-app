import { expect, test } from "vitest";
import { nameLabel } from "./name";

test("an inflected Name shows base form, case and number", () => {
  expect(nameLabel("Kasi", "Kasia", ["Case=Gen", "Number=Sing"])).toBe(
    "Kasi → Kasia · genitivo singolare (dopełniacz)",
  );
});

test("a nominative Name gets no label", () => {
  expect(nameLabel("Kasia ", "Kasia", ["Case=Nom", "Number=Sing"])).toBeNull();
});

test("without tags, a surface that differs from the base is labelled without case", () => {
  expect(nameLabel("Warszawie", "Warszawa", null)).toBe("Warszawie → Warszawa");
  expect(nameLabel("Marco ", "Marco", null)).toBeNull();
});

test("an indeclinable Name tagged with a case gets no label", () => {
  expect(nameLabel("Marco", "Marco", ["Case=Acc", "Number=Sing"])).toBeNull();
});

test("an oblique form the tagger calls nominative is labelled without case", () => {
  expect(nameLabel("Kasi", "Kasia", ["Case=Nom", "Number=Sing"])).toBe("Kasi → Kasia");
});

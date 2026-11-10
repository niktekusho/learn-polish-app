import { expect, test } from "vitest";
import { correction, proofread } from "./llm";

test("proofread: parses flagged spans, an empty list is valid", () => {
  const text = "Duża torta jest gotowa.";
  const errors = [{ span: "Duża torta", reason: "tort è maschile" }];
  expect(proofread.parse(JSON.stringify({ errors }), text)).toEqual(errors);
  expect(proofread.parse('```json\n{"errors":[]}\n```', text)).toEqual([]);
  expect(() => proofread.parse(JSON.stringify({ errors: [{ span: "x" }] }), text)).toThrow();
});

test("proofread: a span missing from the text is junk", () => {
  const errors = [{ span: "duży tort", reason: "?" }];
  expect(() => proofread.parse(JSON.stringify({ errors }), "Duża torta.")).toThrow(/not in/);
});

test("proofread and correction prompts carry the text and every flagged span", () => {
  const text = "Duża torta jest gotowa.";
  expect(proofread.prompt(text)).toContain(text);
  const prompt = correction.prompt({
    text,
    flags: [{ span: "torta", reason: "not in the home dictionary" }],
  });
  expect(prompt).toContain(text);
  expect(prompt).toContain("«torta»: not in the home dictionary");
});

test("corrected text: trims fences, rejects empty output", () => {
  const req = { text: "Duża torta.", flags: [] };
  expect(correction.parse("```\nDuży tort.\n```", req)).toBe("Duży tort.");
  expect(() => correction.parse(" ", req)).toThrow();
});

test("the stub correction drops the flagged spans", () => {
  const req = { text: "Duży torta tort jest gotowy.", flags: [{ span: "torta", reason: "x" }] };
  expect(correction.stub(req)).toBe("Duży tort jest gotowy.");
});

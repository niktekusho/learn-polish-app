import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import type { AnalyzeResponse } from "#/import/sidecar";
import { callsNamed, fakeLlm } from "#/llm/fake";
import type { CorrectionRequest, ProofreadFlag } from "./llm";
import { dictionaryFlags, proofreadText, textChanges } from "./proofread";

const DICTIONARY = new Set(["duży", "tort", "jest", "gotowy", "dziękuję", "polsko", "włoski"]);
const inDictionary = (w: string) => DICTIONARY.has(w.toLowerCase());

// Space-separated words; `-` and `,` split off without whitespace, like spaCy.
function analysisOf(text: string, pos: Record<string, string> = {}): AnalyzeResponse {
  const tokens = text
    .split(/(\s+|-|,|\.)/)
    .filter(Boolean)
    .map((w) => ({
      surface: w,
      lemma: w,
      pos: /^\s+$/.test(w) ? "SPACE" : /^\p{L}/u.test(w) ? (pos[w] ?? "NOUN") : "PUNCT",
      tags: [],
      is_space: /^\s+$/.test(w),
    }));
  return { sentences: [{ tokens }] };
}

test("dictionary guard flags words absent from the home dictionary, case-insensitively", () => {
  expect(dictionaryFlags(analysisOf("Duża torta jest gotowa."), inDictionary)).toEqual([
    { span: "Duża", reason: "not in the home dictionary" },
    { span: "torta", reason: "not in the home dictionary" },
    { span: "gotowa", reason: "not in the home dictionary" },
  ]);
  expect(dictionaryFlags(analysisOf("Duży tort jest gotowy."), inDictionary)).toEqual([]);
});

test("dictionary guard skips names, punctuation and syllabified words", () => {
  const text = "Hanna, dzię-ku-ję - tort.";
  expect(dictionaryFlags(analysisOf(text, { Hanna: "PROPN" }), inDictionary)).toEqual([]);
});

test("dictionary guard accepts a hyphenated compound of dictionary words", () => {
  expect(dictionaryFlags(analysisOf("polsko-włoski tort"), inDictionary)).toEqual([]);
  expect(dictionaryFlags(analysisOf("polsko-tortowy"), inDictionary)).toEqual([
    { span: "tortowy", reason: "not in the home dictionary" },
  ]);
});

test("dictionary guard flags each surface once", () => {
  expect(dictionaryFlags(analysisOf("torta torta"), inDictionary)).toHaveLength(1);
});

function dictionaryDb(words: string[]) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  for (const word of words) {
    const [{ id }] = db
      .insert(schema.dictEntry)
      .values({ word, pos: "noun" })
      .returning({ id: schema.dictEntry.id })
      .all();
    db.insert(schema.dictForm).values({ entryId: id, form: word, tags: [] }).run();
  }
  return db;
}

/** An LLM answering from queues: `reviews` per proofread call, `fixes` per correction. */
function fakeProofreader(reviews: ProofreadFlag[][] = [], fixes: string[] = []) {
  return fakeLlm({
    answers: {
      proofread: () => reviews.shift() ?? [],
      correction: () => fixes.shift() ?? "",
    },
  });
}

const proofreads = (llm: ReturnType<typeof fakeLlm>) =>
  callsNamed(llm, "proofread").map((c) => c.req as string);
const corrections = (llm: ReturnType<typeof fakeLlm>) =>
  callsNamed(llm, "correction").map((c) => (c.req as CorrectionRequest).flags);

const analyze = async (text: string) => analysisOf(text);
const WORDS = ["duży", "tort", "jest", "gotowy"];

test("a clean text makes one proofread call and no correction", async () => {
  const llm = fakeProofreader();
  const out = await proofreadText(dictionaryDb(WORDS), { llm, analyze }, "Duży tort jest gotowy.");
  expect(out).toMatchObject({ text: "Duży tort jest gotowy.", flags: [], rounds: 0 });
  expect(calls(llm)).toEqual({ proofread: 1, correct: 0 });
});

test("dictionary and reviewer flags go to one correction, whose text is checked again", async () => {
  const review = [{ span: "jest gotowa", reason: "accordo" }];
  const llm = fakeProofreader([review, []], ["Duży tort jest gotowy."]);
  const db = dictionaryDb(WORDS);
  const out = await proofreadText(db, { llm, analyze }, "Duży torta jest gotowa.");

  expect(out.text).toBe("Duży tort jest gotowy.");
  expect(out.analysis.sentences[0].tokens.map((t) => t.surface)).toContain("tort");
  expect(corrections(llm)).toEqual([
    [
      { span: "torta", reason: "not in the home dictionary" },
      { span: "gotowa", reason: "not in the home dictionary" },
      ...review,
    ],
  ]);
  expect(proofreads(llm)).toEqual(["Duży torta jest gotowa.", "Duży tort jest gotowy."]);
});

test("a correction still flagged is corrected again with what is left", async () => {
  const llm = fakeProofreader([], ["Duży torta jest gotowy.", "Duży tort jest gotowy."]);
  const out = await proofreadText(dictionaryDb(WORDS), { llm, analyze }, "Duża torta jest gotowa.");
  expect(out).toMatchObject({ text: "Duży tort jest gotowy.", rounds: 2 });
  expect(corrections(llm)[1]).toEqual([{ span: "torta", reason: "not in the home dictionary" }]);
});

test("a text still flagged after three corrections fails, naming the provider, the cause and the span", async () => {
  const stuck = "Duży torta jest gotowy.";
  const llm = fakeProofreader([], [stuck, stuck, stuck, "Duży tort jest gotowy."]);
  const run = proofreadText(dictionaryDb(WORDS), { llm, analyze }, stuck);
  await expect(run).rejects.toThrow(/"stub".*still flagged.*«torta»: not in the home dictionary/);
  expect(corrections(llm)).toHaveLength(3);
});

test("a failing proofread call names the provider and the cause", async () => {
  const llm = fakeLlm({ fails: [new Error("proofread output is not JSON")] });
  const run = proofreadText(dictionaryDb(WORDS), { llm, analyze }, "Duży tort.");
  await expect(run).rejects.toThrow(
    'Proofread by provider "stub" failed: proofread output is not JSON',
  );
});

test("without a home dictionary only the reviewer flags", async () => {
  const llm = fakeProofreader();
  await proofreadText(dictionaryDb([]), { llm, analyze }, "Duża torta.");
  expect(calls(llm)).toEqual({ proofread: 1, correct: 0 });
});

function calls(llm: ReturnType<typeof fakeLlm>) {
  return { proofread: proofreads(llm).length, correct: corrections(llm).length };
}

test("changes are listed per sentence, and per paragraph where sentences merge", () => {
  const before = "Jest ranek.\n\nNastępny dzień. Marco jest w piekarni. Kasia je tortę.";
  const after = "Jest ranek.\n\nNastępnego dnia Marco jest w piekarni. Kasia je tort.";
  expect(textChanges(before, after)).toEqual([
    '"Następny dzień. Marco jest w piekarni. Kasia je tortę." → "Następnego dnia Marco jest w piekarni. Kasia je tort."',
  ]);
  expect(textChanges("Duża torta. Kot śpi.", "Duży tort. Kot śpi.")).toEqual([
    '"Duża torta." → "Duży tort."',
  ]);
});

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import type { AnalyzeResponse } from "#/import/sidecar";
import type { ProofreadFlag } from "#/llm/provider";
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

/** A proofreader answering from queues: `reviews` per proofread call, `fixes` per correction. */
function fakeProofreader(reviews: ProofreadFlag[][] = [], fixes: string[] = []) {
  const calls = { proofread: [] as string[], correct: [] as ProofreadFlag[][] };
  return {
    calls,
    name: "stub" as const,
    async proofread(text: string) {
      calls.proofread.push(text);
      return reviews.shift() ?? [];
    },
    async correct(_text: string, flags: ProofreadFlag[]) {
      calls.correct.push(flags);
      return fixes.shift() ?? "";
    },
  };
}

const analyze = async (text: string) => analysisOf(text);
const WORDS = ["duży", "tort", "jest", "gotowy"];

test("a clean text makes one proofread call and no correction", async () => {
  const provider = fakeProofreader();
  const out = await proofreadText(
    dictionaryDb(WORDS),
    { provider, analyze },
    "Duży tort jest gotowy.",
  );
  expect(out).toMatchObject({ text: "Duży tort jest gotowy.", flags: [] });
  expect(calls(provider)).toEqual({ proofread: 1, correct: 0 });
});

test("dictionary and reviewer flags go to one correction, whose text is checked again", async () => {
  const review = [{ span: "jest gotowa", reason: "accordo" }];
  const provider = fakeProofreader([review, []], ["Duży tort jest gotowy."]);
  const db = dictionaryDb(WORDS);
  const out = await proofreadText(db, { provider, analyze }, "Duży torta jest gotowa.");

  expect(out.text).toBe("Duży tort jest gotowy.");
  expect(out.analysis.sentences[0].tokens.map((t) => t.surface)).toContain("tort");
  expect(provider.calls.correct).toEqual([
    [
      { span: "torta", reason: "not in the home dictionary" },
      { span: "gotowa", reason: "not in the home dictionary" },
      ...review,
    ],
  ]);
  expect(provider.calls.proofread).toEqual(["Duży torta jest gotowa.", "Duży tort jest gotowy."]);
});

test("a correction still flagged fails, naming the provider, the cause and the span", async () => {
  const provider = fakeProofreader([], ["Duży torta jest gotowy."]);
  const run = proofreadText(dictionaryDb(WORDS), { provider, analyze }, "Duży torta jest gotowy.");
  await expect(run).rejects.toThrow(/"stub".*still flagged.*«torta»: not in the home dictionary/);
});

test("a provider that cannot proofread fails the text", async () => {
  const provider = { name: "stub" as const };
  const run = proofreadText(dictionaryDb(WORDS), { provider, analyze }, "Duży tort.");
  await expect(run).rejects.toThrow(/"stub" cannot proofread/);
});

test("a failing proofread call names the provider and the cause", async () => {
  const provider = {
    ...fakeProofreader(),
    proofread: async () => Promise.reject(new Error("proofread output is not JSON")),
  };
  const run = proofreadText(dictionaryDb(WORDS), { provider, analyze }, "Duży tort.");
  await expect(run).rejects.toThrow(
    'Proofread by provider "stub" failed: proofread output is not JSON',
  );
});

test("without a home dictionary only the reviewer flags", async () => {
  const provider = fakeProofreader();
  await proofreadText(dictionaryDb([]), { provider, analyze }, "Duża torta.");
  expect(calls(provider)).toEqual({ proofread: 1, correct: 0 });
});

function calls(p: ReturnType<typeof fakeProofreader>) {
  return { proofread: p.calls.proofread.length, correct: p.calls.correct.length };
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

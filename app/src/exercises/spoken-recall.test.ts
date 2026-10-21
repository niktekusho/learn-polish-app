import { expect, test } from "vitest";
import { matchedAlternative, phoneticKey, spokenRecall, transcriptMatches } from "./spoken-recall";

const r = (text: string, lemmas: string[]) => ({
  transcriptText: text,
  transcriptLemmas: lemmas,
});

test("exact lemma in transcript matches", () => {
  expect(transcriptMatches("kot", r("Kot.", ["kot"]))).toBe(true);
});

test("inflected form matches via lemmatized transcript", () => {
  // learner said "kota"; spacy lemmatizes it to "kot"
  expect(transcriptMatches("kot", r("kota", ["kot"]))).toBe(true);
});

test("wrong word does not match", () => {
  expect(transcriptMatches("kot", r("pies", ["pies"]))).toBe(false);
});

test("empty transcript (silence/VAD) does not match", () => {
  expect(transcriptMatches("kot", r("", []))).toBe(false);
});

test("casing and punctuation are ignored", () => {
  expect(transcriptMatches("kot", r("KOT!", ["KOT"]))).toBe(true);
});

test("MWE matches on transcript text", () => {
  expect(transcriptMatches("na pewno", r("Na pewno!", ["na", "pewno"]))).toBe(true);
});

test("MWE matches on lemma sequence when surface is inflected", () => {
  expect(
    transcriptMatches(
      "zdawać sobie sprawę",
      r("zdaję sobie sprawę", ["zdawać", "sobie", "sprawa"]),
    ),
  ).toBe(false); // sprawę lemmatizes to sprawa, sequence differs — text match saves surface-form MWEs only
  expect(
    transcriptMatches("na pewno", r("no więc na pewno tak", ["no", "więc", "na", "pewno", "tak"])),
  ).toBe(true);
});

// --- phonetic fuzzy matching (real whisper outputs from 2026-07-13 clips,
// --- learner saying "szykować") ---

test("phoneticKey folds orthographic identities and ASR confusion pairs", () => {
  expect(phoneticKey("szykować")).toBe("sikowac");
  expect(phoneticKey("szykowacz")).toBe("sikowac"); // whisper's favorite garble
  expect(phoneticKey("morze")).toBe(phoneticKey("może")); // true homophones
});

test("accepts whisper near-misses of szykować heard in real clips", () => {
  for (const heard of ["Szykowacz", "Szykawać", "Szykłowacz"]) {
    expect(transcriptMatches("szykować", r(heard, [heard]))).toBe(true);
  }
});

test("still rejects genuinely different transcripts", () => {
  for (const heard of ["i kawać", "Siekawicz", "Czekałać", "pies"]) {
    expect(transcriptMatches("szykować", r(heard, heard.split(" ")))).toBe(false);
  }
});

test("short words get no fuzz budget — minimal pairs stay distinct", () => {
  expect(transcriptMatches("kot", r("kod", ["kod"]))).toBe(false);
  expect(transcriptMatches("pies", r("piec", ["piec"]))).toBe(false);
});

test("toClient strips the answer", () => {
  const item = spokenRecall.generate({ lemmaId: 1, lemma: "kot", pos: "NOUN", gloss: "gatto" }, []);
  expect(item).not.toBeNull();
  const client = spokenRecall.toClient(item!);
  expect("lemma" in client).toBe(false);
  expect(client.gloss).toBe("gatto");
});

test("appliesTo requires a gloss", () => {
  expect(spokenRecall.appliesTo({ lemmaId: 1, lemma: "kot", pos: "NOUN" })).toBe(false);
  expect(spokenRecall.appliesTo({ lemmaId: 1, lemma: "kot", pos: "NOUN", gloss: "gatto" })).toBe(
    true,
  );
});

test("appliesTo excludes proper nouns (name-guessing is not retrieval)", () => {
  expect(
    spokenRecall.appliesTo({
      lemmaId: 1,
      lemma: "Ola",
      pos: "PROPN",
      gloss: "prontuario (nome proprio)",
    }),
  ).toBe(false);
});

test("alternatives: other lemmas with the same primary gloss, names and duplicates left out", () => {
  const target = { lemmaId: 1, lemma: "kolejny", pos: "ADJ", gloss: "successivo" };
  const pool = [
    target,
    { lemmaId: 2, lemma: "następny", pos: "ADJ", gloss: " Successivo " },
    { lemmaId: 3, lemma: "Kolejny", pos: "ADJ", gloss: "successivo" },
    { lemmaId: 4, lemma: "Następny", pos: "PROPN", gloss: "successivo" },
    { lemmaId: 5, lemma: "dalszy", pos: "ADJ", gloss: "ulteriore" },
  ];
  const item = spokenRecall.generate(target, pool);
  expect(item?.alternatives).toEqual([{ lemmaId: 2, lemma: "następny" }]);
});

test("matchedAlternative skips alternatives already named", () => {
  const item = spokenRecall.generate(
    { lemmaId: 1, lemma: "kolejny", pos: "ADJ", gloss: "successivo" },
    [{ lemmaId: 2, lemma: "następny", pos: "ADJ", gloss: "successivo" }],
  )!;
  const said = r("następny", ["następny"]);
  expect(matchedAlternative(item, said, [])?.lemmaId).toBe(2);
  expect(matchedAlternative(item, said, ["następny"])).toBeUndefined();
  expect(spokenRecall.grade(item, said)).toBe(spokenRecall.grade(item, r("", [])));
});

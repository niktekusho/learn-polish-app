// Measures episode writing on a scratch COPY of the app DB (its known lemmas and
// dictionary), with the claude CLI and the analyzer sidecar (SIDECAR_URL).
//   run <label> <n> <out.json>   n raw first drafts, analyzed and proofread
//   full <label> <n> <out.json>  n episodes through the app's pipeline: drafts,
//                                level retries, Proofread and Corrections
//   ab <n> <out.json>            n raw drafts with Italian and n with Polish
//                                instructions, judged blind in pairs by the check model
//   compare <a.json> <b.json>... the means of saved runs side by side
// To compare prompt versions with run or full, run once per version (git stash between).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmCall } from "#/llm/cli";
import type { LlmTier } from "#/llm/call";
import type { EpisodeRequest } from "#/story/llm";

interface Sample {
  words: number;
  avgSentenceWords: number;
  lemmaVariety: number;
  repeatedOpenings: number;
  newShare: number;
  inLevelRange: number; // 1 or 0
  dictionaryFlags: number;
  llmFlags: number;
  // Full pipeline only.
  drafts?: number;
  rounds?: number;
  calls?: number;
  seconds?: number;
  failed?: number; // 1 when the pipeline threw
  callsByName?: Record<string, number>;
  changes?: string[]; // what the Corrections changed
  error?: string;
  text: string;
}
interface Verdict {
  winner: "it" | "pl" | "tie" | "error"; // error: the judge reply did not parse
  calques: { it: string[]; pl: string[] };
  reason: string;
}
interface Run {
  label: string;
  samples: Sample[];
  verdicts?: Verdict[];
}
const METRICS = [
  "words",
  "avgSentenceWords",
  "lemmaVariety",
  "repeatedOpenings",
  "newShare",
  "inLevelRange",
  "dictionaryFlags",
  "llmFlags",
  "drafts",
  "rounds",
  "calls",
  "seconds",
  "failed",
] as const;

const PREMISE = { title: "Il gatto di Ala", genre: "quotidiano", hook: "Ala cerca il suo gatto." };
const REQUEST: Omit<EpisodeRequest, "newShare" | "feedback"> = {
  premise: PREMISE,
  outline: {
    plot: "Ala vive a Varsavia. Il suo gatto Burek sparisce e lei lo cerca con un vicino.",
    characters: ["Ala (giovane donna)", "Burek (il gatto)", "Pan Jan (il vicino)"],
    beats: [
      "Ala si sveglia, fa freddo, Burek non c'è",
      "Ala chiede aiuto a Pan Jan",
      "lo trovano in un negozio di pane",
    ],
  },
  previous: null,
  episodeNumber: 1,
  totalEpisodes: 3,
};

/** The episode instructions in Polish; the plan stays Italian, as the learner reads it. */
async function polishEpisodePrompt(req: EpisodeRequest): Promise<string> {
  const { EPISODE_WORDS, beatText } = await import("#/story/llm");
  return (
    `Napisz odcinek ${req.episodeNumber} z ${req.totalEpisodes} opowiadania w odcinkach ` +
    "PO POLSKU dla włoskiego ucznia, który dopiero zaczyna (poniżej A1).\n\n" +
    `Długość: ${EPISODE_WORDS} słów.\n` +
    "Język: naturalna polszczyzna, tak jak napisałby to rodzimy użytkownik. Tam, gdzie " +
    "włoski mówi 'avere' + odczucie, polski ma inną konstrukcję. Pragnienie wyraża " +
    "czasownik, a nie sam przedmiot pragnienia. Szyk zdania jest naturalny. Jeśli proste " +
    "słowa nie wystarczą, żeby powiedzieć coś naturalnie, użyj innego słowa albo powiedz to inaczej.\n" +
    "Rytm: każde zdanie wnosi nowy fakt, działanie albo kwestię dialogu; budowa zdań się " +
    "zmienia, a zdania łączą się spójnikami.\n" +
    "Dialogi: jak w polskich książkach, każda kwestia zaczyna się od nowej linii i od " +
    "półpauzy (–), bez cudzysłowu.\n" +
    "Poziom: prosta gramatyka i najczęstsze polskie słowa; kilka rzadszych słów, " +
    "zrozumiałych z kontekstu.\n" +
    "Fabuła: trzymaj się planu (jest po włosku) i zachowaj spójność z poprzednim odcinkiem. " +
    (req.episodeNumber === req.totalEpisodes ? "To ostatni odcinek: zakończ historię.\n" : "\n") +
    "Odpowiedz WYŁĄCZNIE polskim tekstem odcinka, bez tytułu, tłumaczenia i komentarzy.\n\n" +
    `Tytuł: ${req.premise.title}\nFabuła (po włosku): ${req.outline.plot}\n` +
    `Postacie: ${req.outline.characters.join("; ")}\n` +
    `Plan odcinków (po włosku):\n${req.outline.beats.map((b, i) => `${i + 1}. ${beatText(b)}`).join("\n")}\n\n` +
    (req.previous
      ? `Poprzedni odcinek (${req.episodeNumber - 1}):\n${req.previous}`
      : "Poprzedni odcinek: brak, to pierwszy odcinek.")
  );
}

function judgePrompt(a: string, b: string): string {
  return (
    "You are a native Polish editor. Two short Polish texts for a beginner learner tell " +
    "the same story. Decide which reads as more natural Polish, the way a native would " +
    "write it. Simple sentences are intended and are not a fault. List every calque of " +
    "Italian or other construction a native would not use (e.g. 'mam zimno' for 'jest mi " +
    "zimno'), copied exactly from the text. Reply ONLY with valid JSON, no text around it: " +
    '{"winner":"A"|"B"|"tie","calquesA":["..."],"calquesB":["..."],"reason":"one or two sentences"}' +
    `\n\nText A:\n${a}\n\nText B:\n${b}`
  );
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "measure-episodes-"));
  const real =
    process.env.DATABASE_PATH ?? fileURLToPath(new URL("../data/app.db", import.meta.url));
  // The backup API includes writes still in the WAL file, which a file copy misses.
  const { default: Database } = await import("better-sqlite3");
  const source = new Database(real, { readonly: true });
  await source.backup(join(dir, "app.db"));
  source.close();
  process.env.DATABASE_PATH = join(dir, "app.db");

  const { db } = await import("#/db/index");
  const { knownLemmas } = await import("#/fsrs/index");
  const { analyze } = await import("#/import/sidecar");
  const { ClaudeCliProvider, claudeTiers, readClaudeReply, runClaude } =
    await import("#/llm/claude-cli");
  const { dictionaryFlags, homeDictionary, NOT_IN_DICTIONARY } =
    await import("#/proofread/proofread");
  const { proofread } = await import("#/proofread/llm");
  const { episodeMetrics } = await import("#/story/metrics");
  const { inLevelRange } = await import("#/story/service");
  const calls: LlmCall[] = [];
  const llm = new ClaudeCliProvider(runClaude, (c) => calls.push(c));
  const tiers = claudeTiers();
  const ask = async (prompt: string, tier: LlmTier) =>
    readClaudeReply(await runClaude(prompt, tiers[tier])).text;
  const known = new Set(knownLemmas(db).map((l) => l.toLowerCase()));
  const inDictionary = homeDictionary(db);

  /** Metrics of a text, with flags from a fresh Proofread. */
  async function measure(text: string): Promise<Sample> {
    const analysis = await analyze(text);
    const m = episodeMetrics(analysis, known);
    const flags = [
      ...dictionaryFlags(analysis, inDictionary),
      ...(await llm.call(proofread, text)),
    ];
    return {
      ...m,
      inLevelRange: inLevelRange(m.newShare) ? 1 : 0,
      dictionaryFlags: flags.filter((f) => f.reason === NOT_IN_DICTIONARY).length,
      llmFlags: flags.filter((f) => f.reason !== NOT_IN_DICTIONARY).length,
      text,
    };
  }
  return { db, analyze, llm, ask, calls, measure };
}

async function run(label: string, n: number, out: string) {
  const { llm, measure } = await setup();
  const { episode } = await import("#/story/llm");
  const { NEW_SHARE_TARGET } = await import("#/story/service");
  const samples: Sample[] = [];
  for (let i = 0; i < n; i++) {
    samples.push(
      await measure(await llm.call(episode, { ...REQUEST, newShare: NEW_SHARE_TARGET })),
    );
    console.error(`${label} ${i + 1}/${n}`);
  }
  save(out, { label, samples });
}

async function full(label: string, n: number, out: string) {
  const { db, analyze, llm, calls, measure } = await setup();
  const { writeEpisode } = await import("#/story/service");
  const { textChanges } = await import("#/proofread/proofread");
  const samples: Sample[] = [];
  for (let i = 0; i < n; i++) {
    calls.length = 0;
    const start = Date.now();
    let sample: Sample;
    try {
      const w = await writeEpisode(db, { llm, analyze }, REQUEST);
      // The extra Proofread in measure() is not part of the pipeline: take the stats first.
      const stats = callStats(calls, start);
      sample = {
        ...(await measure(w.text)),
        drafts: w.drafts,
        rounds: w.rounds,
        changes: textChanges(w.draft, w.text),
        ...stats,
        failed: 0,
      };
    } catch (err) {
      sample = {
        ...emptySample(),
        ...callStats(calls, start),
        failed: 1,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    samples.push(sample);
    console.error(`${label} ${i + 1}/${n}${sample.failed ? ` failed: ${sample.error}` : ""}`);
  }
  save(out, { label, samples });
}

function callStats(calls: LlmCall[], start: number) {
  const callsByName: Record<string, number> = {};
  for (const c of calls) callsByName[c.call] = (callsByName[c.call] ?? 0) + 1;
  return { calls: calls.length, callsByName, seconds: (Date.now() - start) / 1000 };
}

function emptySample(): Sample {
  return {
    words: 0,
    avgSentenceWords: 0,
    lemmaVariety: 0,
    repeatedOpenings: 0,
    newShare: 0,
    inLevelRange: 0,
    dictionaryFlags: 0,
    llmFlags: 0,
    text: "",
  };
}

async function ab(n: number, out: string) {
  const { ask, measure } = await setup();
  const { episode } = await import("#/story/llm");
  const { NEW_SHARE_TARGET } = await import("#/story/service");
  const { z } = await import("zod");
  const req = { ...REQUEST, newShare: NEW_SHARE_TARGET };
  const prompts = { it: episode.prompt(req), pl: await polishEpisodePrompt(req) };
  const runs: Record<"it" | "pl", Run> = {
    it: { label: "it", samples: [] },
    pl: { label: "pl", samples: [] },
  };
  const verdicts: Verdict[] = [];
  const judgement = z.object({
    winner: z.enum(["A", "B", "tie"]),
    calquesA: z.array(z.string()),
    calquesB: z.array(z.string()),
    reason: z.string(),
  });
  for (let i = 0; i < n; i++) {
    for (const lang of ["it", "pl"] as const) {
      const text = episode.parse(await ask(prompts[lang], "story"), req);
      runs[lang].samples.push(await measure(text));
    }
    // Blind: a coin decides which text is A.
    const itFirst = Math.random() < 0.5;
    const [a, b] = itFirst ? (["it", "pl"] as const) : (["pl", "it"] as const);
    const raw = await ask(judgePrompt(runs[a].samples[i].text, runs[b].samples[i].text), "check");
    try {
      const j = judgement.parse(JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")));
      verdicts.push({
        winner: j.winner === "tie" ? "tie" : j.winner === "A" ? a : b,
        calques: { [a]: j.calquesA, [b]: j.calquesB } as Verdict["calques"],
        reason: j.reason,
      });
    } catch {
      verdicts.push({ winner: "error", calques: { it: [], pl: [] }, reason: raw.slice(0, 300) });
    }
    // Saved after every pair: a later failure keeps the pairs judged so far.
    writeFileSync(out, JSON.stringify({ runs, verdicts }, null, 2));
    console.error(`ab ${i + 1}/${n}: ${verdicts.at(-1)!.winner}`);
  }
  console.log(table([runs.it, runs.pl]));
  const wins = (w: Verdict["winner"]) => verdicts.filter((v) => v.winner === w).length;
  const calques = (l: "it" | "pl") => verdicts.reduce((t, v) => t + v.calques[l].length, 0);
  console.log(
    `\njudge: it ${wins("it")}, pl ${wins("pl")}, tie ${wins("tie")}, unparsed ${wins("error")}; ` +
      `calques it ${calques("it")}, pl ${calques("pl")}`,
  );
}

function save(out: string, r: Run) {
  writeFileSync(out, JSON.stringify(r, null, 2));
  console.log(table([r]));
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

function table(runs: Run[]): string {
  const rows = [["metric", ...runs.map((r) => `${r.label} (n=${r.samples.length})`)]];
  for (const metric of METRICS) {
    if (!runs.some((r) => r.samples.some((s) => s[metric] !== undefined))) continue;
    rows.push([metric, ...runs.map((r) => mean(r.samples.map((s) => s[metric] ?? 0)).toFixed(2))]);
  }
  const width = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r) => r.map((cell, c) => cell.padEnd(width[c])).join("  ")).join("\n");
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "run" && args.length === 3) {
  await run(args[0], Number(args[1]), args[2]);
} else if (cmd === "full" && args.length === 3) {
  await full(args[0], Number(args[1]), args[2]);
} else if (cmd === "ab" && args.length === 2) {
  await ab(Number(args[0]), args[1]);
} else if (cmd === "compare" && args.length >= 2) {
  console.log(table(args.map((p) => JSON.parse(readFileSync(p, "utf8")) as Run)));
} else {
  console.error(
    "usage: measure-episodes.ts run|full <label> <n> <out.json> | ab <n> <out.json> | compare <a.json> <b.json>...",
  );
  process.exit(1);
}

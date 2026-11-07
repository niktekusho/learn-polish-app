// Benchmarks the Conversation character (#29): replays canned Conversations through the warm
// Claude session for every model by effort cell, then asks the learner to rate a blind
// sample of the character's lines. Needs the analyzer sidecar (SIDECAR_URL) and reads
// known lemmas, read-only, from the dev DB (DATABASE_PATH, default app/data/app.db).
//   bench-conversation.ts <out.json> [runs]   runs: replays of each one, default 2
// out.json is saved after every cell and every rating, and a rerun resumes from it.
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "#/db/schema";
import { knownLemmas } from "#/fsrs/index";
import { analyze } from "#/import/sidecar";
import { ClaudeSession, spawnClaudeSession, type SpawnSession } from "#/llm/claude-session";
import type { ModelChoice } from "#/llm/cli";
import {
  buildCharacterBrief,
  type BriefProfile,
  type CharacterBrief,
} from "#/llm/conversation-brief";
import type { TurnResult } from "#/llm/conversation-session";
import { levelOf } from "#/story/metrics";

// Cheapest first: the report breaks a rating-per-cost tie with this order.
const CELLS: ModelChoice[] = ["claude-haiku-5-5", "claude-sonnet-5-5"].flatMap((model) =>
  ["low", "medium", "high"].map((effort) => ({ model, effort })),
);
const MAX_P90_S = 10;
const MIN_LEVEL_FIT = 0.85;
const MIN_ACCURACY = 0.9;
const RATINGS_PER_CELL = 6;
const PROD_DIR = join(homedir(), "Library/Application Support/learn-polish");

interface Turn {
  say: string; // the learner's line, as Whisper might transcribe it
  understood: boolean;
  ticks: string[]; // Goal step ids this turn completes
}
interface CannedConversation extends Omit<CharacterBrief, "profile" | "memory"> {
  name: string;
  turns: Turn[];
}

const PROFILE: BriefProfile = {
  name: "Marco",
  job: "programmatore",
  city: "Milano",
  partner: "Ola, polacca, di Cracovia",
  hobbies: "videogiochi, cucina",
};

const CONVERSATIONS: CannedConversation[] = [
  {
    name: "piekarnia",
    character: "Pani Ala, la fornaia del quartiere",
    scene: "Mattina, nella piccola panetteria sotto casa a Varsavia.",
    steps: [
      { id: "buy-rolls", text: "Compra due panini" },
      { id: "ask-makowiec", text: "Chiedi se c'è il makowiec fresco" },
      { id: "pay", text: "Paga" },
    ],
    roleFacts: null,
    dueLemmas: ["bułka", "świeży"],
    turns: [
      { say: "Dzień dobry. Poproszę dwie bułki.", understood: true, ticks: ["buy-rolls"] },
      { say: "Czy jest świeży makowiec?", understood: true, ticks: ["ask-makowiec"] },
      { say: "Ile kot chmura okno jutro?", understood: false, ticks: [] },
      { say: "Proszę, tu są pieniądze. Do widzenia.", understood: true, ticks: ["pay"] },
    ],
  },
  {
    name: "sąsiad",
    character: "Pan Jan, il vicino anziano",
    scene:
      "Sulle scale del condominio. Burek, il gatto di Ala, la vicina di sopra, è sparito da ieri.",
    steps: [
      { id: "greet", text: "Saluta Pan Jan" },
      { id: "say-job", text: "Digli che lavoro fai" },
      { id: "ask-cat", text: "Chiedi se ha visto Burek" },
    ],
    roleFacts: null,
    dueLemmas: ["kot", "praca"],
    turns: [
      { say: "Dzień dobry, panie Janie!", understood: true, ticks: ["greet"] },
      { say: "Non so come si dice in polacco.", understood: false, ticks: [] },
      { say: "Jestem programistą. Lavoro w domu.", understood: true, ticks: ["say-job"] },
      { say: "Czy pan widział Burka?", understood: true, ticks: ["ask-cat"] },
    ],
  },
  {
    name: "kawiarnia",
    character: "Kasia, la barista",
    scene: "Pomeriggio, in un caffè affollato del centro.",
    steps: [
      { id: "order-coffee", text: "Ordina un caffè con latte" },
      { id: "order-cake", text: "Ordina una fetta di sernik" },
      { id: "pay-card", text: "Paga con la carta" },
    ],
    roleFacts: null,
    dueLemmas: ["kawa", "karta"],
    turns: [
      {
        say: "Poproszę kawę z mlekiem i sernik.",
        understood: true,
        ticks: ["order-coffee", "order-cake"],
      },
      { say: "Szafa leci przez ogórek wczoraj.", understood: false, ticks: [] },
      { say: "Płacę con la carta.", understood: true, ticks: ["pay-card"] },
      { say: "Dziękuję, do widzenia!", understood: true, ticks: [] },
    ],
  },
  {
    name: "recepcja",
    character: "Pan Tomek, il receptionist dell'albergo",
    scene: "Sera, alla reception di un piccolo albergo a Cracovia.",
    steps: [
      { id: "say-booking", text: "Dì che hai una prenotazione" },
      { id: "give-name", text: "Dai il tuo cognome" },
      { id: "ask-breakfast", text: "Chiedi a che ora è la colazione" },
    ],
    roleFacts: "Hai una prenotazione a nome Rossi per due notti.",
    dueLemmas: ["śniadanie", "pokój"],
    turns: [
      { say: "Dobry wieczór. Mam rezerwację.", understood: true, ticks: ["say-booking"] },
      { say: "Nazywam się Rossi.", understood: true, ticks: ["give-name"] },
      { say: "Rano księżyc kanapa dwa niebiesko.", understood: false, ticks: [] },
      { say: "O której jest śniadanie?", understood: true, ticks: ["ask-breakfast"] },
    ],
  },
];

interface Reply {
  conversation: string;
  say: string;
  line: string | null; // null when the turn failed
  italian: string | null;
  ms: number;
  error: string | null;
  understoodOk: boolean;
  stepsOk: boolean; // the Goal checklist after this turn matches the known answer
}
interface Cell extends ModelChoice {
  replies: Reply[];
  costUsd: number;
  levelFit: number;
}
interface Rating {
  cell: string;
  reply: number;
  score: number | null;
}
interface Results {
  runs: number;
  cells: Record<string, Cell>;
  ratings: Rating[];
}

const cellKey = (c: ModelChoice) => `${c.model}/${c.effort}`;

/** Known lemmas of the dev DB, opened read-only; refuses the prod DB. */
function knownSet(): Set<string> {
  const path =
    process.env.DATABASE_PATH ?? fileURLToPath(new URL("../data/app.db", import.meta.url));
  if (realpathSync(path).startsWith(`${PROD_DIR}/`)) {
    throw new Error(`refusing the prod DB at ${path}: point DATABASE_PATH at a dev or scratch DB`);
  }
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  const known = new Set(knownLemmas(drizzle(sqlite, { schema })).map((l) => l.toLowerCase()));
  sqlite.close();
  return known;
}

/**
 * A spawner that adds up what each process reports. A result event's `total_cost_usd`
 * is the process total so far, so each turn adds the difference from the last one.
 */
function costMeter() {
  let usd = 0;
  const spawn: SpawnSession = (args) => {
    const proc = spawnClaudeSession(args);
    let last = 0;
    return {
      ...proc,
      onLine: (handler) =>
        proc.onLine((line) => {
          const total = resultCost(line);
          if (total !== null) {
            usd += total - last;
            last = total;
          }
          handler(line);
        }),
    };
  };
  return { spawn, total: () => usd };
}

function resultCost(line: string): number | null {
  try {
    const event = JSON.parse(line);
    return event?.type === "result" && typeof event.total_cost_usd === "number"
      ? event.total_cost_usd
      : null;
  } catch {
    return null;
  }
}

const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function runCell(choice: ModelChoice, runs: number, known: Set<string>): Promise<Cell> {
  const meter = costMeter();
  const lines: string[] = [];
  const replies: Reply[] = [];
  for (let run = 1; run <= runs; run++) {
    for (const conv of CONVERSATIONS) {
      const session = new ClaudeSession(meter.spawn, undefined, choice);
      const ticked = new Set<string>();
      const expected = new Set<string>();
      const tick = (r: TurnResult) => r.stepsTicked.forEach((id) => ticked.add(id));
      try {
        const opening = await session.start({
          brief: buildCharacterBrief({ ...conv, profile: PROFILE, memory: [] }),
          stepIds: conv.steps.map((s) => s.id),
          transcript: [],
        });
        lines.push(opening.line);
        tick(opening);
      } catch (err) {
        // A failed start leaves the session seeded: the first turn respawns it.
        console.error(`  ${conv.name} opening failed: ${errorText(err)}`);
      }
      for (const turn of conv.turns) {
        turn.ticks.forEach((id) => expected.add(id));
        const start = Date.now();
        let result: TurnResult | null = null;
        let error: string | null = null;
        try {
          result = await session.send(turn.say);
          lines.push(result.line);
          tick(result);
        } catch (err) {
          error = errorText(err);
        }
        replies.push({
          conversation: conv.name,
          say: turn.say,
          line: result?.line ?? null,
          italian: result?.italian ?? null,
          ms: Date.now() - start,
          error,
          understoodOk: result?.understood === turn.understood,
          stepsOk: result !== null && sameSet(ticked, expected),
        });
      }
      session.close();
      console.error(`  ${cellKey(choice)} run ${run}/${runs} ${conv.name} done`);
    }
  }
  // A cell with no lines has no fit to measure: 0 fails it instead of passing it.
  const levelFit =
    lines.length === 0 ? 0 : 1 - levelOf(await analyze(lines.join("\n")), known).share;
  return { ...choice, replies, costUsd: meter.total(), levelFit };
}

function shuffle<T>(xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

/**
 * A random sample of the replies of each cell not sampled yet, mixed into the pending
 * ratings so the rater can't tell the cells apart.
 */
function pickRatings(results: Results): Rating[] {
  const sampled = new Set(results.ratings.map((r) => r.cell));
  const picked = Object.entries(results.cells)
    .filter(([cell]) => !sampled.has(cell))
    .flatMap(([cell, c]) =>
      shuffle(
        c.replies.flatMap((r, reply) => (r.line ? [{ cell, reply, score: null }] : [])),
      ).slice(0, RATINGS_PER_CELL),
    );
  const rated = results.ratings.filter((r) => r.score !== null);
  const pending = results.ratings.filter((r) => r.score === null);
  return [...rated, ...shuffle([...pending, ...picked])];
}

async function rate(results: Results, save: () => void) {
  const todo = results.ratings.filter((r) => r.score === null);
  if (todo.length === 0) return;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  console.error(
    "\nRate how natural each character line sounds: 1 unnatural, 2 acceptable, 3 like a native.",
  );
  for (const [i, r] of todo.entries()) {
    const reply = results.cells[r.cell].replies[r.reply];
    console.error(
      `\n[${i + 1}/${todo.length}] ${reply.conversation}\n  learner:   ${reply.say}\n` +
        `  character: ${reply.line}\n             (${reply.italian})`,
    );
    let answer = "";
    while (!["1", "2", "3"].includes(answer)) answer = (await rl.question("1-3> ")).trim();
    r.score = Number(answer);
    save();
  }
  rl.close();
}

function percentile(xs: number[], p: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.ceil(p * sorted.length) - 1];
}
const share = (xs: boolean[]) => xs.filter(Boolean).length / (xs.length || 1);

function report(results: Results): string {
  const stats = CELLS.filter((c) => results.cells[cellKey(c)]).map((choice) => {
    const key = cellKey(choice);
    const c = results.cells[key];
    const ms = c.replies.map((r) => r.ms);
    const scores = results.ratings.filter((r) => r.cell === key && r.score !== null);
    const rating = scores.reduce((t, r) => t + r.score!, 0) / (scores.length || 1);
    const costPerTurn = c.costUsd / (c.replies.length || 1);
    const s = {
      key,
      choice,
      p50: percentile(ms, 0.5) / 1000,
      p90: percentile(ms, 0.9) / 1000,
      fit: c.levelFit,
      steps: share(c.replies.map((r) => r.stepsOk)),
      understood: share(c.replies.map((r) => r.understoodOk)),
      errors: c.replies.filter((r) => r.error).length,
      costPerTurn,
      rating,
      // Rating per US cent of a turn: how much naturalness a unit of cost buys.
      ratingPerCent: costPerTurn > 0 ? rating / (costPerTurn * 100) : 0,
    };
    const fails = [
      s.p90 > MAX_P90_S && "p90",
      s.fit < MIN_LEVEL_FIT && "fit",
      s.steps < MIN_ACCURACY && "steps",
      s.understood < MIN_ACCURACY && "understood",
    ].filter((f) => f !== false);
    return { ...s, fails };
  });
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const rows = [
    [
      "cell",
      "p50",
      "p90",
      "fit",
      "steps",
      "underst.",
      "errors",
      "$/turn",
      "rating",
      "rating/¢",
      "pass",
    ],
    ...stats.map((s) => [
      s.key,
      `${s.p50.toFixed(1)}s`,
      `${s.p90.toFixed(1)}s`,
      pct(s.fit),
      pct(s.steps),
      pct(s.understood),
      String(s.errors),
      s.costPerTurn.toFixed(4),
      s.rating.toFixed(2),
      s.ratingPerCent.toFixed(2),
      s.fails.length === 0 ? "yes" : `no: ${s.fails.join(", ")}`,
    ]),
  ];
  const width = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  const table = rows.map((r) => r.map((cell, c) => cell.padEnd(width[c])).join("  ")).join("\n");
  const passing = stats.filter((s) => s.fails.length === 0);
  const winner = [...passing].sort((a, b) => b.ratingPerCent - a.ratingPerCent)[0];
  const rule =
    `A cell passes with p90 <= ${MAX_P90_S}s, level fit >= ${pct(MIN_LEVEL_FIT)} and step and ` +
    `understood accuracy >= ${pct(MIN_ACCURACY)}. The passing cell with the highest rating per cost wins.`;
  const verdict = winner
    ? `Winner: ${winner.key}. Ship it with CLAUDE_CONVERSATION_MODEL=${winner.choice.model} ` +
      `CLAUDE_CONVERSATION_EFFORT=${winner.choice.effort}.`
    : "No cell passes.";
  return `${table}\n\n${rule}\n${verdict}`;
}

async function main(out: string, runs: number) {
  const results: Results = existsSync(out)
    ? JSON.parse(readFileSync(out, "utf8"))
    : { runs, cells: {}, ratings: [] };
  if (results.runs !== runs) {
    throw new Error(
      `${out} holds ${results.runs} runs per cell: rerun it with runs ${results.runs}`,
    );
  }
  const save = () => writeFileSync(out, JSON.stringify(results, null, 2));
  const known = knownSet();
  for (const choice of CELLS) {
    const key = cellKey(choice);
    if (results.cells[key]) continue;
    console.error(`${key}: ${CONVERSATIONS.length * runs} replays`);
    results.cells[key] = await runCell(choice, runs, known);
    save();
  }
  results.ratings = pickRatings(results);
  save();
  await rate(results, save);
  console.log(report(results));
}

const [out, runs = "2"] = process.argv.slice(2);
if (!out || !(Number(runs) >= 1)) {
  console.error("usage: bench-conversation.ts <out.json> [runs]");
  process.exit(1);
}
await main(out, Number(runs));

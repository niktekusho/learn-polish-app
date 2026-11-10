import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ClaudeSession, type SessionProcess } from "./claude-session";
import { LAST_TURN_NOTE, type SessionSeed } from "./conversation-session";
import type { LlmCall } from "./cli";

const seed: SessionSeed = {
  brief: "You are Ela, a baker.",
  stepIds: ["order", "pay"],
  transcript: [],
};

const turn = {
  line: "Dzień dobry!",
  italian: "Buongiorno!",
  understood: true,
  stepsTicked: [] as string[],
  hint: ["bułki"],
  modelLine: "Poproszę dwie bułki.",
};

/** The result event `claude -p --output-format stream-json` ends a turn with. */
const resultEvent = (result: unknown = turn) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_api_ms: 900,
    result: typeof result === "string" ? result : JSON.stringify(result),
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 300,
      output_tokens: 40,
    },
  });

/** A fake process: records stdin lines, and the test pushes stdout lines. */
class FakeProcess implements SessionProcess {
  written: string[] = [];
  killed = false;
  private lineHandler: (line: string) => void = () => {};
  private exitHandler: (code: number | null) => void = () => {};
  constructor(readonly args: string[]) {}
  write(line: string) {
    this.written.push(line);
  }
  onLine(handler: (line: string) => void) {
    this.lineHandler = handler;
  }
  onExit(handler: (code: number | null) => void) {
    this.exitHandler = handler;
  }
  kill() {
    this.killed = true;
    this.exitHandler(null);
  }
  emit(line: string) {
    this.lineHandler(line);
  }
  crash() {
    this.exitHandler(1);
  }
  /** The text of the user message written at `i`. */
  userText(i: number): string {
    return JSON.parse(this.written[i]).message.content;
  }
}

let procs: FakeProcess[];
let calls: LlmCall[];
const spawner = (args: string[]) => {
  const p = new FakeProcess(args);
  procs.push(p);
  return p;
};
const session = () =>
  new ClaudeSession(spawner, (c) => calls.push(c), { model: "claude-haiku-5-5", effort: "low" });
const flag = (p: FakeProcess, name: string) => p.args[p.args.indexOf(name) + 1];

beforeEach(() => {
  vi.useFakeTimers();
  procs = [];
  calls = [];
});
afterEach(() => vi.useRealTimers());

test("start passes the brief and schema as flags and seeds one message with the transcript", async () => {
  const s = session();
  const started = s.start({
    ...seed,
    transcript: [
      { speaker: "character", text: "Dzień dobry!" },
      { speaker: "learner", text: "Poproszę bułkę." },
    ],
  });
  procs[0].emit(resultEvent());
  expect(await started).toEqual(turn);

  const p = procs[0];
  expect(flag(p, "--system-prompt")).toBe(seed.brief);
  expect(flag(p, "--model")).toBe("claude-haiku-5-5");
  expect(flag(p, "--effort")).toBe("low");
  expect(p.args).toEqual(expect.arrayContaining(["--input-format", "stream-json"]));
  const schema = JSON.parse(flag(p, "--json-schema"));
  expect(schema.properties.stepsTicked.items.enum).toEqual(["order", "pay"]);
  expect(schema).not.toHaveProperty("$schema");
  expect(p.written).toHaveLength(1);
  expect(p.userText(0)).toContain("Learner: Poproszę bułkę.");
  expect(p.userText(0)).toContain("Character: Dzień dobry!");
});

test("send writes the learner turn to the same process and parses the result event", async () => {
  const s = session();
  const started = s.start(seed);
  procs[0].emit(resultEvent());
  await started;

  const next = { ...turn, line: "Dwie bułki, proszę.", stepsTicked: ["order"] };
  const sent = s.send("Poproszę dwie bułki.");
  procs[0].emit(resultEvent(next));
  expect(await sent).toEqual(next);
  expect(procs).toHaveLength(1);
  expect(procs[0].userText(1)).toBe("Poproszę dwie bułki.");
});

test("non-JSON, schema-invalid and unknown-step replies fail the attempt", async () => {
  for (const bad of [
    "Sure! Here is the line",
    { ...turn, understood: "yes" },
    { ...turn, stepsTicked: ["dance"] },
  ]) {
    const s = session();
    const started = s.start(seed);
    procs[procs.length - 1].emit(resultEvent(bad));
    await expect(started).rejects.toThrow();
  }
});

test("a turn reply wrapped in a markdown fence still parses", async () => {
  const s = session();
  const started = s.start(seed);
  procs[0].emit(resultEvent("```json\n" + JSON.stringify(turn) + "\n```"));
  expect(await started).toEqual(turn);
});

test("an error result event fails the attempt", async () => {
  const s = session();
  const started = s.start(seed);
  procs[0].emit(
    JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }),
  );
  await expect(started).rejects.toThrow(/error_during_execution/);
});

test("a turn over 30s kills the process and fails the attempt", async () => {
  const s = session();
  const started = s.start(seed);
  const assertion = expect(started).rejects.toThrow(/30s/);
  await vi.advanceTimersByTimeAsync(30_000);
  await assertion;
  expect(procs[0].killed).toBe(true);
});

test("a process that exits mid-turn fails the attempt, and the next send respawns reseeded", async () => {
  const s = session();
  const started = s.start(seed);
  procs[0].emit(resultEvent());
  await started;

  const lost = s.send("Poproszę bułkę.");
  procs[0].crash();
  await expect(lost).rejects.toThrow(/exited/);

  const retry = s.send("Poproszę bułkę.");
  procs[1].emit(resultEvent());
  await retry;
  expect(procs).toHaveLength(2);
  expect(procs[1].written).toHaveLength(1);
  expect(procs[1].userText(0)).toContain("Character: Dzień dobry!");
  expect(procs[1].userText(0)).toContain("Learner: Poproszę bułkę.");
});

test("a session idle for 10 minutes is killed, and the next turn reseeds a fresh process", async () => {
  const s = session();
  const started = s.start(seed);
  procs[0].emit(resultEvent());
  await started;

  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(procs[0].killed).toBe(true);

  const sent = s.send("Poproszę bułkę.");
  procs[1].emit(resultEvent({ ...turn, line: "Proszę." }));
  expect((await sent).line).toBe("Proszę.");
  expect(procs[1].userText(0)).toBe(
    "Scene so far:\nCharacter: Dzień dobry!\nLearner: Poproszę bułkę.\n\nReply as the character to the learner's last line.",
  );
});

test("close kills the process", async () => {
  const s = session();
  const started = s.start(seed);
  procs[0].emit(resultEvent());
  await started;
  s.close();
  expect(procs[0].killed).toBe(true);
});

test("each warm turn logs the stdin message, the response, usage and API time", async () => {
  const s = session();
  const started = s.start(seed);
  procs[0].emit(resultEvent());
  await started;
  const sent = s.send("Poproszę bułkę.");
  procs[0].emit(resultEvent());
  await sent;

  expect(calls).toMatchObject([
    { call: "turn", model: "claude-haiku-5-5", effort: "low", error: null },
    {
      call: "turn",
      prompt: "Poproszę bułkę.",
      response: JSON.stringify(turn),
      inputTokens: 402,
      outputTokens: 40,
      cacheReadTokens: 300,
      apiMs: 900,
      ms: expect.any(Number),
      error: null,
    },
  ]);
  expect(calls[0].prompt).toContain("opening line");
});

test("a failed turn is logged with the error", async () => {
  const s = session();
  const started = s.start(seed);
  procs[0].emit(resultEvent("not json"));
  await expect(started).rejects.toThrow();
  expect(calls).toMatchObject([{ call: "turn", response: "not json", error: expect.any(String) }]);
});

test("a scene without Goal steps still gets a valid schema that ticks nothing", async () => {
  const s = session();
  const started = s.start({ ...seed, stepIds: [] });
  procs[0].emit(resultEvent());
  await started;
  expect(JSON.parse(flag(procs[0], "--json-schema")).properties.stepsTicked.maxItems).toBe(0);
});

test("warm spawns the process at once, and the first send seeds it with the transcript", async () => {
  const s = session();
  s.warm({ ...seed, transcript: [{ speaker: "character", text: "Dzień dobry!" }] });
  expect(procs).toHaveLength(1);
  expect(procs[0].written).toHaveLength(0);

  const sent = s.send("Poproszę bułkę.");
  procs[0].emit(resultEvent());
  await sent;
  expect(procs).toHaveLength(1);
  expect(procs[0].userText(0)).toBe(
    "Scene so far:\nCharacter: Dzień dobry!\nLearner: Poproszę bułkę.\n\nReply as the character to the learner's last line.",
  );
});

test("a warmed session left without a turn for 10 minutes is killed", async () => {
  const s = session();
  s.warm(seed);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(procs[0].killed).toBe(true);
});

test("warming a session that already runs a process spawns nothing", () => {
  const s = session();
  s.warm(seed);
  s.warm(seed);
  expect(procs).toHaveLength(1);
});

test("each turn is logged with the learner turn it answers and the attempt it was sent as", async () => {
  const opened = { ...seed, transcript: [{ speaker: "character" as const, text: "Dzień dobry!" }] };
  const s = session();
  s.warm(opened);
  const lost = s.send("Poproszę bułkę.", { attempt: 1 });
  procs[0].crash();
  await expect(lost).rejects.toThrow();
  const fresh = session();
  fresh.warm(opened);
  const retry = fresh.send("Poproszę bułkę.", { attempt: 2 });
  procs[1].emit(resultEvent());
  await retry;
  const next = fresh.send("Dziękuję.");
  procs[1].emit(resultEvent());
  await next;

  expect(calls.map((c) => [c.turn, c.attempt])).toEqual([
    [1, 1],
    [1, 2],
    [2, 1],
  ]);
});

test("the last turn tells the character to close the scene, on a warm or a reseeded process", async () => {
  const s = session();
  const started = s.start(seed);
  procs[0].emit(resultEvent());
  await started;

  const ordinary = s.send("Poproszę bułkę.");
  procs[0].emit(resultEvent());
  await ordinary;
  expect(procs[0].userText(1)).not.toContain(LAST_TURN_NOTE);

  const lost = s.send("Do widzenia.", { lastTurn: true });
  expect(procs[0].userText(2)).toContain("Do widzenia.");
  expect(procs[0].userText(2)).toContain(LAST_TURN_NOTE);
  procs[0].crash();
  await expect(lost).rejects.toThrow(/exited/);

  const retry = s.send("Do widzenia.", { lastTurn: true });
  procs[1].emit(resultEvent());
  await retry;
  expect(procs[1].userText(0)).toContain("Learner: Do widzenia.");
  expect(procs[1].userText(0)).toContain(LAST_TURN_NOTE);
});

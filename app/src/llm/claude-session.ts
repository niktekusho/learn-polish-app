// Protocol facts (flags, event shapes): docs/research/claude-cli-stream-json.md
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EMPTY_CWD, LEAN_ARGS, claudeTiers, readClaudeReply } from "./claude-cli";
import { NO_USAGE, type LlmCall, type ModelChoice, type Usage } from "./cli";
import {
  buildSeedMessage,
  parseTurnResult,
  turnResultSchema,
  type ConversationSession,
  type SessionSeed,
  type TranscriptLine,
  type TurnResult,
} from "./conversation-session";
import { z } from "zod";

const TURN_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 10 * 60_000;

/** A running `claude` process, reduced to the lines it exchanges. Each handler setter replaces the last. */
export interface SessionProcess {
  write(line: string): void;
  onLine(handler: (line: string) => void): void;
  onExit(handler: (code: number | null) => void): void;
  kill(): void;
}

export type SpawnSession = (args: string[]) => SessionProcess;

export const spawnClaudeSession: SpawnSession = (args) => {
  const child = spawn("claude", args, { cwd: EMPTY_CWD, stdio: ["pipe", "pipe", "ignore"] });
  // One handler each: a new onLine/onExit replaces the last, so a warm process
  // does not gather a listener per turn.
  let onLine: (line: string) => void = () => {};
  let onExit: (code: number | null) => void = () => {};
  createInterface({ input: child.stdout }).on("line", (line) => onLine(line));
  child.on("close", (code) => onExit(code));
  child.on("error", () => onExit(null));
  return {
    write: (line) => child.stdin.write(`${line}\n`),
    onLine: (handler) => {
      onLine = handler;
    },
    onExit: (handler) => {
      onExit = handler;
    },
    kill: () => child.kill(),
  };
};

function sessionArgs(seed: SessionSeed, { model, effort }: ModelChoice): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    "--effort",
    effort,
    "--system-prompt",
    seed.brief,
    "--json-schema",
    JSON.stringify(turnJsonSchema(seed.stepIds)),
    ...LEAN_ARGS,
  ];
}

// The CLI fails to start on the draft 2020-12 `$schema` URL zod writes: it bundles no such draft.
function turnJsonSchema(stepIds: string[]) {
  const { $schema: _, ...schema } = z.toJSONSchema(turnResultSchema(stepIds), { io: "input" });
  return schema;
}

const userMessage = (text: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: text } });

/**
 * One warm `claude` process per Conversation. The process is killed when a turn fails,
 * times out or sits idle. The next turn spawns a fresh one, seeded with the transcript.
 */
export class ClaudeSession implements ConversationSession {
  private seed: SessionSeed | null = null;
  private transcript: TranscriptLine[] = [];
  private proc: SessionProcess | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor(
    private readonly spawnSession: SpawnSession = spawnClaudeSession,
    private readonly log: (call: LlmCall) => void = () => {},
    private readonly choice: ModelChoice = claudeTiers().conversation,
  ) {}

  start(seed: SessionSeed): Promise<TurnResult> {
    this.close();
    this.seed = seed;
    this.transcript = [...seed.transcript];
    return this.turn(null);
  }

  send(learnerTurn: string): Promise<TurnResult> {
    if (!this.seed) return Promise.reject(new Error("session not started"));
    return this.turn(learnerTurn);
  }

  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.proc?.kill();
    this.proc = null;
  }

  private async turn(learnerTurn: string | null): Promise<TurnResult> {
    const seed = this.seed!;
    if (this.busy) throw new Error("a turn is already in progress");
    this.busy = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const start = Date.now();
    const asked: TranscriptLine[] = learnerTurn ? [{ speaker: "learner", text: learnerTurn }] : [];
    // A warm process holds the transcript already, so it gets the bare turn.
    const message = this.proc
      ? (learnerTurn ?? "")
      : buildSeedMessage([...this.transcript, ...asked]);
    let response: string | null = null;
    let usage: Usage = NO_USAGE;
    const log = (error: string | null) =>
      this.log({
        call: "turn",
        ...this.choice,
        prompt: message,
        response,
        ...usage,
        ms: Date.now() - start,
        error,
      });
    try {
      const proc = (this.proc ??= this.spawnSession(sessionArgs(seed, this.choice)));
      const line = await this.nextResult(proc, message);
      const reply = readClaudeReply({ code: 0, stdout: line, stderr: "" });
      response = reply.text;
      usage = reply.usage;
      const result = parseTurnResult(reply.text, seed.stepIds);
      this.transcript.push(...asked, { speaker: "character", text: result.line });
      this.idleTimer = setTimeout(() => this.close(), IDLE_TIMEOUT_MS);
      this.idleTimer.unref?.();
      log(null);
      return result;
    } catch (err) {
      this.close();
      log(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /** Writes one user message and resolves with the raw `result` event line. */
  private nextResult(proc: SessionProcess, message: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`turn timed out after ${TURN_TIMEOUT_MS / 1000}s`)),
        TURN_TIMEOUT_MS,
      );
      proc.onLine((line) => {
        if (!isResultEvent(line)) return;
        clearTimeout(timer);
        resolve(line);
      });
      proc.onExit((code) => {
        clearTimeout(timer);
        reject(new Error(`claude exited ${code} mid-turn`));
      });
      proc.write(userMessage(message));
    });
  }
}

function isResultEvent(line: string): boolean {
  try {
    return JSON.parse(line)?.type === "result";
  } catch {
    return false;
  }
}

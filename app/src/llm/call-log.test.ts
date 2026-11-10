import { gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import { recordCall } from "./call-log";
import { ClaudeCliProvider } from "./claude-cli";
import type { CallSpec } from "./call";
import type { LlmCall } from "./cli";

function migratedDb() {
  const db = drizzle(new Database(":memory:"), { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  return db;
}

const echo: CallSpec<{ sentence: string }, string> = {
  name: "echo",
  tier: "gloss",
  prompt: (req) => `Repeat: ${req.sentence}`,
  parse: (text) => text,
  stub: (req) => req.sentence,
};

const unzip = (blob: Buffer | null) => (blob ? gunzipSync(blob).toString("utf8") : null);

const call: LlmCall = {
  call: "episode",
  model: "m",
  effort: "medium",
  prompt: "Napisz odcinek. Zażółć gęślą jaźń.",
  response: "Ala ma kota.",
  inputTokens: 10,
  outputTokens: 4,
  cacheReadTokens: 2,
  apiMs: 3,
  ms: 5,
  error: null,
};

test("a call is stored with its provider, and a long error is cut to 500 characters", () => {
  const db = migratedDb();
  recordCall(db, "claude-cli", call);
  recordCall(db, "claude-cli", { ...call, error: "x".repeat(900) });

  const rows = db.select().from(schema.llmCall).all();
  expect(rows).toMatchObject([
    { provider: "claude-cli", call: "episode", model: "m", effort: "medium", ms: 5, error: null },
    { provider: "claude-cli", call: "episode" },
  ]);
  expect(rows[1].error).toHaveLength(500);
});

test("prompt and response are stored compressed and decompress to the exact text", () => {
  const db = migratedDb();
  recordCall(db, "claude-cli", call);

  const [row] = db.select().from(schema.llmCall).all();
  expect(unzip(row.prompt)).toBe(call.prompt);
  expect(unzip(row.response)).toBe(call.response);
  expect(row.prompt!.length).toBeGreaterThan(0);
  expect(row).toMatchObject({
    promptChars: call.prompt.length,
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 2,
    apiMs: 3,
  });
});

test("a call with no response and no usage stores nulls", () => {
  const db = migratedDb();
  recordCall(db, "codex-cli", {
    ...call,
    response: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    apiMs: null,
    error: "codex exited 1",
  });

  const [row] = db.select().from(schema.llmCall).all();
  expect(unzip(row.prompt)).toBe(call.prompt);
  expect(row).toMatchObject({
    response: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    apiMs: null,
    error: "codex exited 1",
  });
});

test("a Claude CLI call lands in the log with its full text, usage and effort", async () => {
  const db = migratedDb();
  const stdout = JSON.stringify({
    type: "result",
    is_error: false,
    duration_api_ms: 900,
    result: "fare",
    usage: { input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 1 },
  });
  const provider = new ClaudeCliProvider(
    async () => ({ code: 0, stdout, stderr: "" }),
    (c) => recordCall(db, "claude-cli", c),
  );
  await provider.call(echo, { sentence: "Robię obiad." });

  const [row] = db.select().from(schema.llmCall).all();
  expect(unzip(row.prompt)).toContain("Robię obiad.");
  expect(unzip(row.response)).toBe("fare");
  expect(row).toMatchObject({
    provider: "claude-cli",
    call: "echo",
    effort: "medium",
    inputTokens: 25,
    outputTokens: 1,
    cacheReadTokens: 20,
    apiMs: 900,
    error: null,
  });
});

test("a failed Claude CLI call keeps the prompt, the raw output and the error", async () => {
  const db = migratedDb();
  const provider = new ClaudeCliProvider(
    async () => ({ code: 1, stdout: "half a reply", stderr: "" }),
    (c) => recordCall(db, "claude-cli", c),
  );
  await expect(provider.call(echo, { sentence: "Robię obiad." })).rejects.toThrow();

  const [row] = db.select().from(schema.llmCall).all();
  expect(unzip(row.prompt)).toContain("Robię obiad.");
  expect(unzip(row.response)).toBe("half a reply");
  expect(row.error).toBe("claude exited 1: half a reply");
});

test("a Conversation turn is stored with its conversation, turn and attempt; other calls leave them null", () => {
  const db = migratedDb();
  const [s] = db
    .insert(schema.story)
    .values({
      title: "t",
      genre: "g",
      hook: "h",
      outline: { plot: "p", characters: [], beats: ["b"] },
      plannedEpisodes: 1,
      status: "active",
    })
    .returning()
    .all();
  const [e] = db
    .insert(schema.sourceText)
    .values({ content: "c", storyId: s.id })
    .returning()
    .all();
  const [c] = db
    .insert(schema.conversation)
    .values({
      storyId: s.id,
      episodeId: e.id,
      character: "Ala",
      characterLine: "Ala",
      scene: "s",
      steps: [],
      opening: { line: "l", italian: "i", hint: [], modelLine: "m" },
      dueLemmas: [],
    })
    .returning()
    .all();
  recordCall(db, "claude-cli", {
    ...call,
    call: "turn",
    conversationId: c.id,
    turn: 2,
    attempt: 1,
  });
  recordCall(db, "claude-cli", call);

  const rows = db.select().from(schema.llmCall).all();
  expect(rows).toMatchObject([
    { call: "turn", conversationId: c.id, turn: 2, attempt: 1 },
    { call: "episode", conversationId: null, turn: null, attempt: null },
  ]);
});

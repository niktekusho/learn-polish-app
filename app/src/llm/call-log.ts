import { gzipSync } from "node:zlib";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "#/db/schema";
import { llmCall } from "#/db/schema";
import type { LlmCall } from "./cli";
import type { ProviderName } from "./provider";

const MAX_ERROR = 500;

export function recordCall(
  db: BetterSQLite3Database<typeof schema>,
  provider: ProviderName,
  { prompt, response, error, ...call }: LlmCall,
): void {
  db.insert(llmCall)
    .values({
      provider,
      ...call,
      promptChars: prompt.length,
      prompt: gzipSync(prompt),
      response: response === null ? null : gzipSync(response),
      error: error?.slice(0, MAX_ERROR) ?? null,
    })
    .run();
}

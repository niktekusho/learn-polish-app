import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "#/db/schema";
import { conversation, conversationTurn } from "#/db/schema";

type DB = BetterSQLite3Database<typeof schema>;

/** Character lines the learner followed by ear, without revealing them (CONTEXT.md "Heard line"). */
export function heardLineCount(db: DB, id: number): number {
  const c = db.select().from(conversation).where(eq(conversation.id, id)).get();
  if (!c) throw new Error(`no conversation ${id}`);
  const lines = db
    .select({ line: conversationTurn.line, revealed: conversationTurn.lineRevealed })
    .from(conversationTurn)
    .where(eq(conversationTurn.conversationId, id))
    .all()
    .filter((t) => t.line !== null && !t.revealed).length;
  return lines + (c.openingRevealed ? 0 : 1);
}

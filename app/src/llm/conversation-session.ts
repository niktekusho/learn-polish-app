import { z } from "zod";

/** One line of a Conversation, as the learner and the character spoke it. */
export interface TranscriptLine {
  speaker: "character" | "learner";
  text: string;
}

export interface SessionSeed {
  brief: string; // the character brief, passed as the system prompt
  stepIds: string[]; // the Goal step ids the character can tick
  transcript: TranscriptLine[]; // empty for a new Conversation
}

export interface TurnResult {
  line: string; // the character's Polish line
  italian: string; // Italian translation of `line`
  understood: boolean; // did the character understand the learner's turn
  stepsTicked: string[]; // Goal step ids completed this turn, zero or more
  hint: string[]; // key Polish words for the learner's likely next turn
  modelLine: string; // a full Polish sentence for that next turn
}

/**
 * One warm LLM process per Conversation. `start` answers the transcript so far: the
 * opening line when it is empty, the reply to the learner's last line otherwise.
 */
export interface ConversationSession {
  start(seed: SessionSeed): Promise<TurnResult>;
  send(learnerTurn: string): Promise<TurnResult>;
  close(): void;
}

/** Validates a turn result: `stepsTicked` may only hold the scene's step ids. */
export function turnResultSchema(stepIds: string[]) {
  // An empty enum has no JSON schema, so a scene without steps allows an empty list only.
  const ticked =
    stepIds.length > 0
      ? z.array(z.enum(stepIds as [string, ...string[]]))
      : z.array(z.string()).max(0);
  return z.object({
    line: z.string().min(1),
    italian: z.string().min(1),
    understood: z.boolean(),
    stepsTicked: ticked,
    hint: z.array(z.string()),
    modelLine: z.string(),
  });
}

export function parseTurnResult(text: string, stepIds: string[]): TurnResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("turn reply is not JSON");
  }
  const parsed = turnResultSchema(stepIds).safeParse(json);
  if (!parsed.success)
    throw new Error(`turn reply does not match the schema: ${parsed.error.message}`);
  return parsed.data;
}

/** The first message of a process: the transcript so far, then what to answer. */
export function buildSeedMessage(transcript: TranscriptLine[]): string {
  if (transcript.length === 0) return "The scene starts now. Say the character's opening line.";
  const lines = transcript.map(
    (l) => `${l.speaker === "character" ? "Character" : "Learner"}: ${l.text}`,
  );
  return `Scene so far:\n${lines.join("\n")}\n\nReply as the character to the learner's last line.`;
}

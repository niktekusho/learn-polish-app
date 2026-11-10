export type ProviderName = "stub" | "claude-cli" | "codex-cli" | "ollama" | "api" | "manual"; // "manual": a learner-written gloss, from no adapter

/**
 * Which model tier a call needs: stories are longer, level-controlled
 * Polish; a check reviews text a story-tier model wrote.
 */
export type LlmTier = "gloss" | "story" | "check" | "conversation";

export interface CallOptions {
  conversationId?: number; // the call log files the call under this Conversation
}

/** One kind of LLM call. It lives in the feature folder that makes it. */
export interface CallSpec<Req, Res> {
  name: string; // the call log label
  tier: LlmTier;
  prompt(req: Req): string;
  // Throws on junk, so the caller caches nothing.
  parse(text: string, req: Req): Res;
  // The offline result, deterministic and shaped by the request.
  stub(req: Req): Res;
}

export interface Llm {
  readonly name: ProviderName; // recorded on gloss rows, so one adapter's output can be purged
  call<Req, Res>(spec: CallSpec<Req, Res>, req: Req, options?: CallOptions): Promise<Res>;
}

/** An Italian multiple-choice question: comprehension checks and Passage exercises. */
export interface ChoiceQuestion {
  question: string;
  choices: string[]; // 3–4 Italian choices
  correctIndex: number;
}

import { ClaudeCliProvider } from "./claude-cli";
import { ClaudeSession } from "./claude-session";
import type { ConversationSession } from "./conversation-session";
import { ScriptedSession } from "./scripted-session";
import type { LlmCall } from "./cli";
import { CodexCliProvider } from "./codex-cli";
import type { Llm, ProviderName } from "./call";
import { StubProvider } from "./stub";

let cached: Llm | null = null;

// The DB module opens the app DB on import: it loads only when a CLI provider logs a call.
function logTo(provider: ProviderName) {
  return (call: LlmCall) => {
    Promise.all([import("#/db/index"), import("./call-log")])
      .then(([{ db }, { recordCall }]) => recordCall(db, provider, call))
      .catch((err) => console.error("[llm] call log failed:", err));
  };
}

// GLOSS_PROVIDER selects the adapter; the default stub keeps tests and offline dev
// offline. Set GLOSS_PROVIDER=claude-cli or codex-cli to use a real CLI.
export function appLlm(): Llm {
  if (!cached) {
    switch (process.env.GLOSS_PROVIDER) {
      case "claude-cli":
        cached = new ClaudeCliProvider(undefined, logTo("claude-cli"));
        break;
      case "codex-cli":
        cached = new CodexCliProvider(undefined, logTo("codex-cli"));
        break;
      default:
        cached = new StubProvider();
    }
  }
  return cached;
}

// One session per Conversation, so this builds a new one each call. GLOSS_PROVIDER=claude-cli
// runs the warm Claude process; any other value (Codex has no warm session yet) plays the script.
export function createConversationSession(conversationId: number): ConversationSession {
  if (process.env.GLOSS_PROVIDER !== "claude-cli") return new ScriptedSession();
  const log = logTo("claude-cli");
  return new ClaudeSession(undefined, (call) => log({ ...call, conversationId }));
}

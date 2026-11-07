import { ClaudeCliProvider } from "./claude-cli";
import { ClaudeSession } from "./claude-session";
import type { ConversationSession } from "./conversation-session";
import { ScriptedSession } from "./scripted-session";
import type { LlmCall } from "./cli";
import { CodexCliProvider } from "./codex-cli";
import type { GlossProvider, ProviderName, StoryProvider } from "./provider";
import { StubProvider } from "./stub";

let cached: (GlossProvider & StoryProvider) | null = null;

// The DB module opens the app DB on import: it loads only when a CLI provider logs a call.
function logTo(provider: ProviderName) {
  return (call: LlmCall) => {
    Promise.all([import("#/db/index"), import("./call-log")])
      .then(([{ db }, { recordCall }]) => recordCall(db, provider, call))
      .catch((err) => console.error("[llm] call log failed:", err));
  };
}

// GLOSS_PROVIDER selects the concrete provider; default stub keeps tests and
// offline dev untouched. Set GLOSS_PROVIDER=claude-cli or codex-cli to use a
// real CLI.
function provider(): GlossProvider & StoryProvider {
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

export const getGlossProvider = (): GlossProvider => provider();
export const getStoryProvider = (): StoryProvider => provider();

// One session per Conversation, so this builds a new one each call. GLOSS_PROVIDER=claude-cli
// runs the warm Claude process; any other value (Codex has no warm session yet) plays the script.
export function createConversationSession(): ConversationSession {
  return process.env.GLOSS_PROVIDER === "claude-cli"
    ? new ClaudeSession(undefined, logTo("claude-cli"))
    : new ScriptedSession();
}

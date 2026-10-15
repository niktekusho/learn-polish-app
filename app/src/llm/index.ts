import { ClaudeCliProvider } from "./claude-cli";
import { CodexCliProvider } from "./codex-cli";
import type { GlossProvider, StoryProvider } from "./provider";
import { StubProvider } from "./stub";

let cached: (GlossProvider & StoryProvider) | null = null;

// GLOSS_PROVIDER selects the concrete provider; default stub keeps tests and
// offline dev untouched. Set GLOSS_PROVIDER=claude-cli or codex-cli to use a
// real CLI.
function provider(): GlossProvider & StoryProvider {
  if (!cached) {
    switch (process.env.GLOSS_PROVIDER) {
      case "claude-cli":
        cached = new ClaudeCliProvider();
        break;
      case "codex-cli":
        cached = new CodexCliProvider();
        break;
      default:
        cached = new StubProvider();
    }
  }
  return cached;
}

export const getGlossProvider = (): GlossProvider => provider();
export const getStoryProvider = (): StoryProvider => provider();

import { db } from "#/db/index";
import { analyze } from "#/import/sidecar";
import { getGlossProvider } from "#/llm/provider";
import { storyService } from "./service";

/** The story service wired to the app DB, the configured LLM and the sidecar. */
export function appStoryService() {
  return storyService(db, { provider: getGlossProvider(), analyze });
}

import { appConversationService } from "#/conversation/server";
import { db } from "#/db/index";
import { analyze } from "#/import/sidecar";
import { appLlm } from "#/llm/index";
import { storyService } from "./service";

/** The story service wired to the app DB, the configured LLM and the sidecar. */
export function appStoryService() {
  return storyService(db, {
    llm: appLlm(),
    analyze,
    onEpisodeRead: (textId) =>
      appConversationService()
        .prepareScene(textId)
        .catch((err) =>
          console.error(`[conversation] background scene for ${textId} failed:`, err),
        ),
  });
}

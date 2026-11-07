import { db } from "#/db/index";
import { voices } from "#/import/sidecar";
import { createConversationSession, getSceneProvider } from "#/llm/index";
import { conversationService } from "./service";

/** The Conversation service wired to the app DB, the configured LLM and the sidecar. */
export function appConversationService() {
  return conversationService(db, {
    provider: getSceneProvider(),
    voices,
    createSession: createConversationSession,
  });
}

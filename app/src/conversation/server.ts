import { db } from "#/db/index";
import { analyze, voices } from "#/import/sidecar";
import { appLlm, createConversationSession } from "#/llm/index";
import { conversationService } from "./service";

/** The Conversation service wired to the app DB, the configured LLM and the sidecar. */
export function appConversationService() {
  return conversationService(db, {
    llm: appLlm(),
    voices,
    analyze,
    createSession: createConversationSession,
  });
}

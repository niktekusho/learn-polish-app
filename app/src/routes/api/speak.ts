import { createFileRoute } from "@tanstack/react-router";
import { handleSpeak } from "#/audio/piper";

export const Route = createFileRoute("/api/speak")({
  server: { handlers: { GET: ({ request }) => handleSpeak(request) } },
});

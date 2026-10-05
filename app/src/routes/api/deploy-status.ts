import { readFile } from "node:fs/promises";
import { createFileRoute } from "@tanstack/react-router";

export type DeployStatus = {
  sha: string;
  failed: { sha: string; log: string } | null;
};

// A plain URL, not a server function: a client from an older build must still be able to
// call it, and server-function IDs are not stable across builds.
export const Route = createFileRoute("/api/deploy-status")({
  server: {
    handlers: {
      GET: async () => {
        const file = process.env.DEPLOY_FAILED_FILE;
        const failed = file ? await readFile(file, "utf8").then(JSON.parse, () => null) : null;
        const status: DeployStatus = { sha: import.meta.env.VITE_GIT_SHA ?? "dev", failed };
        return Response.json(status, { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});

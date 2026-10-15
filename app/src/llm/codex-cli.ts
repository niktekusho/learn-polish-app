import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { CliProvider } from "./cli";
import type { LlmTask, ProviderName } from "./provider";

// Real Italian gloss via the `codex` CLI already on PATH. Codex exec can print
// progress/log output, so the final assistant message is captured with
// --output-last-message and parsed from that file.

const TIMEOUT_MS = 60_000;

async function runCodex(prompt: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "learn-polish-codex-"));
  const outputPath = join(dir, "last-message.txt");

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("codex", buildCodexArgs(prompt, outputPath), {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: TIMEOUT_MS,
      });

      let stderr = "";
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`codex exited ${code}: ${stderr.trim()}`));
      });
    });

    return await readFile(outputPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function buildCodexArgs(prompt: string, outputPath: string): string[] {
  return ["exec", "--color", "never", "--output-last-message", outputPath, prompt];
}

export class CodexCliProvider extends CliProvider {
  readonly name: ProviderName = "codex-cli";

  constructor(exec: (prompt: string, task: LlmTask) => Promise<string> = runCodex) {
    super(exec);
  }
}

import { spawn } from 'node:child_process'
import {
  buildComprehensionPrompt,
  buildGlossPrompt,
  buildSenseGlossPrompt,
  type ComprehensionRequest,
  type ComprehensionResult,
  type GlossProvider,
  type GlossRequest,
  parseComprehensionJson,
  parseSenseGlossJson,
  type ProviderName,
  type SenseGlossRequest,
  type SenseGlossResult,
} from './provider'

// Real Italian gloss via the `claude` CLI already on PATH (bills the user's
// subscription, no API key). One-shot per lemma: `claude -p "<prompt>"` prints
// the gloss to stdout. Batching is deliberately NOT here — see
// /tmp/learn-polish-gloss-provider-handoff.md for the deferred import-time
// batch decision. This is the click-path provider only.

const TIMEOUT_MS = 60_000
const MAX_GLOSS_LEN = 60

// Run `claude -p <prompt>` with stdin closed. spawn (not execFile) so we can set
// stdin to 'ignore' (= /dev/null): claude -p otherwise treats the non-TTY pipe
// Node hands it as piped input, waits 3s, warns "no stdin data received", and
// exits non-zero. Closing stdin makes it run the prompt argument directly. The
// prompt is a single argv element, so the pasted sentence can't shell-inject.
function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d
    })
    child.stderr.on('data', (d) => {
      stderr += d
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`claude exited ${code}: ${stderr.trim() || stdout.trim()}`))
    })
  })
}

// Validate the raw CLI output. Throws on junk so getGloss() bubbles and nothing
// is cached — a bad gloss written to the cache becomes permanent (#6).
export function parseGloss(stdout: string): string {
  const out = stdout.trim()
  if (!out || out.length > MAX_GLOSS_LEN) {
    throw new Error(`unexpected gloss output: ${JSON.stringify(out.slice(0, 80))}`)
  }
  return out
}

// The shell-out is injectable so tests exercise parseGloss without spawning a
// process. ponytail: single-lemma only; when the batch decision lands, add an
// optional glossBatch() to the GlossProvider interface.
export class ClaudeCliGlossProvider implements GlossProvider {
  readonly name: ProviderName = 'claude-cli'

  constructor(private readonly exec: (prompt: string) => Promise<string> = runClaude) {}

  async gloss(req: GlossRequest): Promise<string> {
    return parseGloss(await this.exec(buildGlossPrompt(req)))
  }

  async glossSenses(req: SenseGlossRequest): Promise<SenseGlossResult> {
    return parseSenseGlossJson(
      await this.exec(buildSenseGlossPrompt(req)),
      req.senses.length,
    )
  }

  async comprehension(req: ComprehensionRequest): Promise<ComprehensionResult> {
    return parseComprehensionJson(await this.exec(buildComprehensionPrompt(req)))
  }
}

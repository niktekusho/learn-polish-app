import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GlossProvider, GlossRequest, ProviderName } from './provider'

// Real Italian gloss via the `claude` CLI already on PATH (bills the user's
// subscription, no API key). One-shot per lemma: `claude -p "<prompt>"` prints
// the gloss to stdout. Batching is deliberately NOT here — see
// /tmp/learn-polish-gloss-provider-handoff.md for the deferred import-time
// batch decision. This is the click-path provider only.

// execFile, not exec: args are passed as an array, so the pasted Polish
// sentence (a trust boundary — quotes/backticks/newlines) never reaches a
// shell and can't inject.
const run = promisify(execFile)

const MAX_GLOSS_LEN = 60

function buildPrompt(req: GlossRequest): string {
  return (
    'Sei un dizionario polacco-italiano. Rispondi SOLO con una glossa ' +
    'italiana breve (1-4 parole) per il lemma, nel senso usato nella frase. ' +
    'Nessuna spiegazione, nessuna punteggiatura finale.\n\n' +
    `Lemma: ${req.lemma}\nPOS: ${req.pos}\nFrase: ${req.sentence}`
  )
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

  constructor(
    private readonly exec: (prompt: string) => Promise<string> = async (p) => {
      const { stdout } = await run('claude', ['-p', p], { timeout: 60_000 })
      return stdout
    },
  ) {}

  async gloss(req: GlossRequest): Promise<string> {
    return parseGloss(await this.exec(buildPrompt(req)))
  }
}

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { GlossProvider, GlossRequest, ProviderName } from './provider'

// Real Italian gloss via the `codex` CLI already on PATH. Codex exec can print
// progress/log output, so the final assistant message is captured with
// --output-last-message and parsed from that file.

const TIMEOUT_MS = 60_000
const MAX_GLOSS_LEN = 60

function buildPrompt(req: GlossRequest): string {
  return (
    'Sei un dizionario polacco-italiano. Rispondi SOLO con una glossa ' +
    'italiana breve (1-4 parole) per il lemma, nel senso usato nella frase. ' +
    'Nessuna spiegazione, nessuna punteggiatura finale.\n\n' +
    `Lemma: ${req.lemma}\nPOS: ${req.pos}\nFrase: ${req.sentence}`
  )
}

async function runCodex(prompt: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'learn-polish-codex-'))
  const outputPath = join(dir, 'last-message.txt')

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'codex',
        buildCodexArgs(prompt, outputPath),
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          timeout: TIMEOUT_MS,
        },
      )

      let stderr = ''
      child.stderr.on('data', (d) => {
        stderr += d
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`codex exited ${code}: ${stderr.trim()}`))
      })
    })

    return await readFile(outputPath, 'utf8')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export function buildCodexArgs(prompt: string, outputPath: string): string[] {
  return ['exec', '--color', 'never', '--output-last-message', outputPath, prompt]
}

export function parseGloss(stdout: string): string {
  const out = stdout.trim()
  if (!out || out.length > MAX_GLOSS_LEN) {
    throw new Error(`unexpected gloss output: ${JSON.stringify(out.slice(0, 80))}`)
  }
  return out
}

export class CodexCliGlossProvider implements GlossProvider {
  readonly name: ProviderName = 'codex-cli'

  constructor(private readonly exec: (prompt: string) => Promise<string> = runCodex) {}

  async gloss(req: GlossRequest): Promise<string> {
    return parseGloss(await this.exec(buildPrompt(req)))
  }
}

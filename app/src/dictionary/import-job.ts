import fs from 'node:fs'
import readline from 'node:readline'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '#/db/schema'
import { insertEntryBatch, wipeDictionary } from './loader'
import { type ParsedEntry, parseKaikkiLine } from './parse'

type DB = BetterSQLite3Database<typeof schema>

// In-process background import of the kaikki JSONL dump. Single-user app:
// one job at a time, status polled by the maintenance page. State lives on
// globalThis so a Vite HMR module reload mid-import doesn't orphan the
// running job's status (don't edit server files during an import anyway).

export interface DictImportStatus {
  state: 'idle' | 'running' | 'done' | 'error'
  filePath: string | null
  startedAt: string | null // ISO
  finishedAt: string | null
  totalBytes: number
  readBytes: number // progress = readBytes / totalBytes
  processedLines: number
  importedEntries: number
  skipped: {
    otherLang: number
    pos: number
    formOf: number
    noSenses: number
    unparsable: number
  }
  error: string | null
}

function freshStatus(): DictImportStatus {
  return {
    state: 'idle',
    filePath: null,
    startedAt: null,
    finishedAt: null,
    totalBytes: 0,
    readBytes: 0,
    processedLines: 0,
    importedEntries: 0,
    skipped: { otherLang: 0, pos: 0, formOf: 0, noSenses: 0, unparsable: 0 },
    error: null,
  }
}

const g = globalThis as typeof globalThis & {
  __dictImportStatus?: DictImportStatus
}

export function getImportStatus(): DictImportStatus {
  return (g.__dictImportStatus ??= freshStatus())
}

const BATCH_SIZE = 500

const SKIP_KEY = {
  'other-lang': 'otherLang',
  pos: 'pos',
  'form-of': 'formOf',
  'no-senses': 'noSenses',
  unparsable: 'unparsable',
} as const

/** Kick off the import and return immediately. Refuses if already running. */
export function startImport(
  db: DB,
  filePath: string,
): { started: boolean; reason?: string } {
  const status = getImportStatus()
  if (status.state === 'running') {
    return { started: false, reason: 'an import is already running' }
  }
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    return { started: false, reason: `file not found: ${filePath}` }
  }
  if (!stat.isFile()) return { started: false, reason: `not a file: ${filePath}` }

  const next = freshStatus()
  next.state = 'running'
  next.filePath = filePath
  next.startedAt = new Date().toISOString()
  next.totalBytes = stat.size
  g.__dictImportStatus = next

  // Fire and forget; the maintenance page polls getImportStatus().
  runImport(db, filePath, next).catch((err) => {
    next.state = 'error'
    next.error = String(err)
    next.finishedAt = new Date().toISOString()
  })
  return { started: true }
}

async function runImport(
  db: DB,
  filePath: string,
  status: DictImportStatus,
): Promise<void> {
  // Idempotent re-import: always start from an empty dictionary.
  wipeDictionary(db)

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  })

  let batch: ParsedEntry[] = []
  const flush = async () => {
    insertEntryBatch(db, batch)
    status.importedEntries += batch.length
    batch = []
    // better-sqlite3 is synchronous: without this yield the status-poll
    // server fn starves for the whole import.
    await new Promise((r) => setImmediate(r))
  }

  for await (const line of rl) {
    status.processedLines++
    status.readBytes += Buffer.byteLength(line, 'utf8') + 1
    const outcome = parseKaikkiLine(line)
    if (outcome.kind === 'skip') {
      // One bad line never aborts the whole import.
      status.skipped[SKIP_KEY[outcome.reason]]++
      continue
    }
    batch.push(outcome.entry)
    if (batch.length >= BATCH_SIZE) await flush()
  }
  await flush()

  status.state = 'done'
  status.finishedAt = new Date().toISOString()
}

import { createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import type { DictImportStatus } from '#/dictionary/import-job'
import type { MaintenanceStats } from '#/maintenance/ops'

const loadStats = createServerFn().handler(async (): Promise<MaintenanceStats> => {
  const { db } = await import('#/db/index')
  const { getStats } = await import('#/maintenance/ops')
  return getStats(db)
})

const actionInput = z.object({
  action: z.enum([
    'clear-texts',
    'prune-lemmas',
    'purge-stub-glosses',
    'clear-dictionary',
  ]),
})

const runAction = createServerFn({ method: 'POST' })
  .validator((d: unknown) => actionInput.parse(d))
  .handler(async ({ data }): Promise<{ deleted: number }> => {
    const { db } = await import('#/db/index')
    const ops = await import('#/maintenance/ops')
    switch (data.action) {
      case 'clear-texts':
        return { deleted: ops.clearSourceTexts(db) }
      case 'prune-lemmas':
        return { deleted: ops.pruneOrphanLemmas(db) }
      case 'purge-stub-glosses':
        return { deleted: ops.purgeStubGlosses(db) }
      case 'clear-dictionary':
        return { deleted: ops.clearDictionary(db) }
    }
  })

const startDictImport = createServerFn({ method: 'POST' })
  .validator((d: unknown) => z.object({ filePath: z.string().min(1) }).parse(d))
  .handler(async ({ data }) => {
    const { db } = await import('#/db/index')
    const { startImport } = await import('#/dictionary/import-job')
    return startImport(db, data.filePath)
  })

const getDictImportStatus = createServerFn().handler(
  async (): Promise<DictImportStatus> => {
    const { getImportStatus } = await import('#/dictionary/import-job')
    return getImportStatus()
  },
)

export const Route = createFileRoute('/maintenance')({
  component: Maintenance,
  loader: () => loadStats(),
})

type Action = z.infer<typeof actionInput>['action']

function Maintenance() {
  const stats = Route.useLoaderData()
  const router = useRouter()
  const [pending, setPending] = useState<Action | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dictPath, setDictPath] = useState('')
  const [dictStatus, setDictStatus] = useState<DictImportStatus | null>(null)

  const importing = dictStatus?.state === 'running'

  // Fetch once on mount (reattaches to a job after a page reload), then poll
  // every second while an import runs; refresh stats when it settles.
  useEffect(() => {
    let stop = false
    getDictImportStatus().then((s) => !stop && setDictStatus(s))
    return () => {
      stop = true
    }
  }, [])
  useEffect(() => {
    if (!importing) return
    const id = setInterval(async () => {
      const s = await getDictImportStatus()
      setDictStatus(s)
      if (s.state !== 'running') await router.invalidate()
    }, 1000)
    return () => clearInterval(id)
  }, [importing, router])

  async function runImport() {
    const filePath = dictPath.trim()
    if (!filePath) return
    if (
      !window.confirm(
        'Import the kaikki dictionary? The current dictionary is wiped and reloaded from the file.',
      )
    )
      return
    setError(null)
    setMessage(null)
    const res = await startDictImport({ data: { filePath } })
    if (!res.started) {
      setError(res.reason ?? 'Import did not start.')
      return
    }
    setDictStatus(await getDictImportStatus())
  }

  async function run(action: Action, confirmText: string, noun: string) {
    if (!window.confirm(confirmText)) return
    setPending(action)
    setMessage(null)
    setError(null)
    try {
      const { deleted } = await runAction({ data: { action } })
      setMessage(`Deleted ${deleted} ${noun}.`)
      await router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operation failed.')
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold">Maintenance</h1>
      <p className="mt-2 text-sm text-gray-600">
        Housekeeping for the vocab store. Glosses (translations) and FSRS
        progress are never touched by "Clear imported texts".
      </p>

      <dl className="mt-6 grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-3">
        <Stat label="Texts" value={stats.texts} />
        <Stat label="Tokens" value={stats.tokens} />
        <Stat label="Lemmas" value={stats.lemmas} />
        <Stat label="Glosses" value={stats.glosses} />
        <Stat label="Stub glosses" value={stats.stubGlosses} />
        <Stat label="Reviews" value={stats.reviews} />
        <Stat label="Dict entries" value={stats.dictEntries} />
        <Stat label="Dict senses" value={stats.dictSenses} />
        <Stat label="Dict forms" value={stats.dictForms} />
        <Stat label="Dict MWEs" value={stats.dictMwes} />
      </dl>

      <div className="mt-8 rounded border border-gray-200 p-4">
        <h2 className="font-semibold">Home dictionary</h2>
        <p className="mt-1 text-sm text-gray-600">
          Import the kaikki.org Polish JSONL dump (see docs/adr/0002). Download
          it manually, then paste the absolute file path (no ~).
        </p>
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={dictPath}
            onChange={(e) => setDictPath(e.target.value)}
            placeholder="/absolute/path/to/kaikki.org-dictionary-Polish.jsonl"
            disabled={importing}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
          <button
            type="button"
            onClick={runImport}
            disabled={importing || dictPath.trim() === ''}
            className="shrink-0 rounded border border-blue-300 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50"
          >
            {importing ? 'Importing…' : 'Import'}
          </button>
        </div>
        {dictStatus && dictStatus.state !== 'idle' && (
          <p className="mt-2 text-sm text-gray-600">
            {dictStatus.state === 'running' &&
              `Imported ${dictStatus.importedEntries} entries — ${
                dictStatus.totalBytes > 0
                  ? Math.round((100 * dictStatus.readBytes) / dictStatus.totalBytes)
                  : 0
              }%`}
            {dictStatus.state === 'done' &&
              `Done: ${dictStatus.importedEntries} entries imported (${dictStatus.processedLines} lines).`}
            {dictStatus.state === 'error' && (
              <span className="text-red-700">Import failed: {dictStatus.error}</span>
            )}
          </p>
        )}
      </div>

      <div className="mt-8 space-y-6">
        <ActionRow
          title="Clear imported texts"
          description="Deletes all imported texts and their tokens. Lemmas, translations, and learning progress are kept."
          button="Clear texts"
          pending={pending === 'clear-texts'}
          disabled={pending !== null || stats.texts === 0}
          onClick={() =>
            run(
              'clear-texts',
              `Delete all ${stats.texts} imported texts? Translations and progress are kept.`,
              'texts',
            )
          }
        />
        <ActionRow
          title="Prune orphan lemmas"
          description="Deletes lemmas that appear in no text, have no translation, and were never practiced. Run after clearing texts to drop the untouched backlog."
          button="Prune lemmas"
          pending={pending === 'prune-lemmas'}
          disabled={pending !== null}
          onClick={() =>
            run(
              'prune-lemmas',
              'Delete all lemmas with no text, no translation, and no review history?',
              'lemmas',
            )
          }
        />
        <ActionRow
          title="Purge stub glosses"
          description="Deletes translations produced by the development stub provider so the real provider can regenerate them."
          button="Purge stubs"
          pending={pending === 'purge-stub-glosses'}
          disabled={pending !== null || stats.stubGlosses === 0}
          onClick={() =>
            run(
              'purge-stub-glosses',
              `Delete ${stats.stubGlosses} stub glosses?`,
              'stub glosses',
            )
          }
        />
        <ActionRow
          title="Clear dictionary"
          description="Deletes the whole home dictionary (entries, senses, forms). Re-import from the kaikki file to restore it."
          button="Clear dictionary"
          pending={pending === 'clear-dictionary'}
          disabled={pending !== null || importing || stats.dictEntries === 0}
          onClick={() =>
            run(
              'clear-dictionary',
              `Delete all ${stats.dictEntries} dictionary entries?`,
              'dictionary entries',
            )
          }
        />
      </div>

      {message && (
        <p className="mt-6 rounded bg-green-50 p-3 text-sm text-green-800">
          {message}
        </p>
      )}
      {error && (
        <p className="mt-6 rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between border-b border-gray-100 py-1">
      <dt className="text-gray-600">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  )
}

function ActionRow(props: {
  title: string
  description: string
  button: string
  pending: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded border border-gray-200 p-4">
      <div>
        <h2 className="font-semibold">{props.title}</h2>
        <p className="mt-1 text-sm text-gray-600">{props.description}</p>
      </div>
      <button
        type="button"
        onClick={props.onClick}
        disabled={props.disabled}
        className="shrink-0 rounded border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
      >
        {props.pending ? 'Working…' : props.button}
      </button>
    </div>
  )
}

import { createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { z } from 'zod'
import type { MaintenanceStats } from '#/maintenance/ops'

const loadStats = createServerFn().handler(async (): Promise<MaintenanceStats> => {
  const { db } = await import('#/db/index')
  const { getStats } = await import('#/maintenance/ops')
  return getStats(db)
})

const actionInput = z.object({
  action: z.enum(['clear-texts', 'prune-lemmas', 'purge-stub-glosses']),
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
    }
  })

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
      </dl>

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

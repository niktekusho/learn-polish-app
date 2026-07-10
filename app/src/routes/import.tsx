import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { z } from 'zod'
import type { ImportResult } from '#/import/pipeline'

const importInput = z.object({
  title: z.string().optional(),
  content: z.string().min(1, 'Paste some Polish text first.'),
})

// Server-only: analyze via the sidecar, then persist. DB + sidecar client are
// imported inside the handler so better-sqlite3 never reaches the browser bundle.
const importText = createServerFn({ method: 'POST' })
  .validator((d: unknown) => importInput.parse(d))
  .handler(async ({ data }): Promise<ImportResult> => {
    const content = data.content.trim()
    if (!content) throw new Error('Paste some Polish text first.')
    const { analyze } = await import('#/import/sidecar')
    const { persistAnalysis } = await import('#/import/pipeline')
    const { db } = await import('#/db/index')
    const analysis = await analyze(content)
    return persistAnalysis(db, { title: data.title || null, content }, analysis)
  })

export const Route = createFileRoute('/import')({ component: Import })

function Import() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setPending(true)
    setError(null)
    setResult(null)
    try {
      const res = await importText({
        data: {
          title: String(form.get('title') ?? ''),
          content: String(form.get('content') ?? ''),
        },
      })
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold">Import Polish text</h1>
      <p className="mt-2 text-sm text-gray-600">
        Paste text; it's analyzed by the morphology sidecar and added to your
        vocab store.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <input
          name="title"
          placeholder="Title (optional)"
          className="w-full rounded border border-gray-300 px-3 py-2"
        />
        <textarea
          name="content"
          required
          rows={10}
          placeholder="Wklej tekst po polsku…"
          className="w-full rounded border border-gray-300 px-3 py-2 font-mono"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-blue-600 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {pending ? 'Analyzing…' : 'Import'}
        </button>
      </form>

      {error && (
        <p className="mt-4 rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>
      )}
      {result && (
        <div className="mt-4 rounded bg-green-50 p-3 text-sm text-green-800">
          Imported text #{result.textId}: {result.tokenCount} tokens,{' '}
          {result.lemmaCount} distinct lemmas.
        </div>
      )}
    </div>
  )
}

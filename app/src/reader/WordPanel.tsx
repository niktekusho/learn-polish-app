import { createServerFn } from '@tanstack/react-start'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import type { ReaderToken } from './types'

// Server-only: resolve (and cache) the Italian gloss for a lemma. The reader
// always has a sentence, so this path may generate; cache-only callers (#10)
// go through getGloss with an empty sentence instead.
const lookupGloss = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    z
      .object({
        lemmaId: z.number().int(),
        lemma: z.string(),
        pos: z.string(),
        sentence: z.string().min(1),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { db } = await import('#/db/index')
    const { getGloss } = await import('#/gloss/service')
    return getGloss(db, data)
  })

// Word detail panel: surface, lemma, POS, the cached Italian gloss, and a
// Wiktionary link (#6).
export function WordPanel({
  token,
  sentence,
  onClose,
}: {
  token: ReaderToken
  sentence: string
  onClose: () => void
}) {
  const [gloss, setGloss] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (token.lemmaId == null || token.lemma == null) return
    let alive = true
    setLoading(true)
    setGloss(null)
    lookupGloss({
      data: {
        lemmaId: token.lemmaId,
        lemma: token.lemma,
        pos: token.pos ?? '',
        sentence,
      },
    })
      .then((r) => alive && setGloss(r.italian))
      .catch(() => alive && setGloss('—'))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [token.lemmaId, token.lemma, token.pos, sentence])

  const wiktionary = token.lemma
    ? `https://en.wiktionary.org/wiki/${encodeURIComponent(token.lemma)}#Polish`
    : null

  return (
    <aside className="fixed right-0 top-0 h-full w-80 border-l border-gray-200 bg-white p-6 shadow-lg">
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 text-gray-400 hover:text-gray-700"
      >
        ✕
      </button>

      <div className="text-2xl font-bold">{token.surface}</div>
      <dl className="mt-4 space-y-2 text-sm">
        <div>
          <dt className="text-gray-500">Lemma</dt>
          <dd className="font-medium">{token.lemma}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Part of speech</dt>
          <dd className="font-medium">{token.pos}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Italiano</dt>
          <dd className="font-medium">
            {loading ? <span className="text-gray-400">…</span> : (gloss ?? '—')}
          </dd>
        </div>
      </dl>

      {wiktionary && (
        <a
          href={wiktionary}
          target="_blank"
          rel="noreferrer"
          className="mt-6 inline-block text-sm text-blue-600 underline"
        >
          Wiktionary ↗
        </a>
      )}
    </aside>
  )
}

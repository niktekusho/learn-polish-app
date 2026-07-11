import { createServerFn } from '@tanstack/react-start'
import { useCallback, useEffect, useState } from 'react'
import { z } from 'zod'
import type { KnowledgeFlags, ReaderToken } from './types'

// Server-only: resolve (and cache) the Italian gloss for a lemma. The reader
// always has a sentence, so this path may generate.
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

// Server-only: grade the receptive track, return the server's fresh verdict.
const markLemma = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    z
      .object({
        lemmaId: z.number().int(),
        rating: z.number().int().min(1).max(4),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<KnowledgeFlags> => {
    const { db } = await import('#/db/index')
    const { gradeLemma } = await import('#/fsrs/index')
    const { knowledgeFlags } = await import('#/reader/knowledge')
    const next = gradeLemma(
      db,
      data.lemmaId,
      'receptive',
      data.rating as 1 | 2 | 3 | 4,
    )
    return knowledgeFlags(next.state)
  })

// ts-fsrs Rating values used by the two learner actions.
const RATING_KNOWN = 4 // Easy: long interval, marks the word learned
const RATING_LEARNING = 1 // Again: short interval, keep it in rotation

export function WordPanel({
  token,
  sentence,
  onGraded,
  onClose,
}: {
  token: ReaderToken
  sentence: string
  onGraded: (lemmaId: number, flags: KnowledgeFlags) => void
  onClose: () => void
}) {
  const [gloss, setGloss] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [marking, setMarking] = useState(false)

  // In the reader the sentence is always present, so lookupGloss either resolves
  // with a gloss or rejects (provider/CLI failure) — a rejection is a real error,
  // not "no translation". Shared by the mount effect and the Retry button.
  const runLookup = useCallback(() => {
    if (token.lemmaId == null || token.lemma == null) return () => {}
    let alive = true
    setLoading(true)
    setError(false)
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
      .catch(() => alive && setError(true))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [token.lemmaId, token.lemma, token.pos, sentence])

  useEffect(() => runLookup(), [runLookup])

  async function mark(rating: number) {
    if (token.lemmaId == null) return
    setMarking(true)
    try {
      const flags = await markLemma({ data: { lemmaId: token.lemmaId, rating } })
      onGraded(token.lemmaId, flags)
      if (flags.known) onClose()
    } finally {
      setMarking(false)
    }
  }

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
            {loading ? (
              <span className="text-gray-400">…</span>
            ) : error ? (
              <span className="text-red-600">
                Traduzione non riuscita{' '}
                <button
                  type="button"
                  onClick={runLookup}
                  className="underline hover:text-red-700"
                >
                  Riprova
                </button>
              </span>
            ) : (
              (gloss ?? '—')
            )}
          </dd>
        </div>
      </dl>

      <div className="mt-6 flex gap-2">
        <button
          type="button"
          disabled={marking}
          onClick={() => mark(RATING_KNOWN)}
          className="rounded bg-green-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          Mark known
        </button>
        <button
          type="button"
          disabled={marking}
          onClick={() => mark(RATING_LEARNING)}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-50"
        >
          Still learning
        </button>
      </div>

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

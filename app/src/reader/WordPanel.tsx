import { createServerFn } from '@tanstack/react-start'
import { useCallback, useEffect, useState } from 'react'
import { z } from 'zod'
import type { DictLookupResult } from '#/dictionary/service'
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

// Server-only: discard the cached gloss and generate a fresh one from context.
const regenerateGlossFn = createServerFn({ method: 'POST' })
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
    const { regenerateGloss } = await import('#/gloss/service')
    return regenerateGloss(db, data)
  })

// Server-only: save a learner-written gloss (provider 'manual').
const saveGlossFn = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    z
      .object({ lemmaId: z.number().int(), italian: z.string().trim().min(1) })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { db } = await import('#/db/index')
    const { setManualGloss } = await import('#/gloss/service')
    return { italian: setManualGloss(db, data.lemmaId, data.italian) }
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

// Server-only: home-dictionary reference for the lemma (senses, IPA, forms,
// etymology). Read-only, no LLM involved.
const lookupDictFn = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    z.object({ lemma: z.string().min(1), pos: z.string() }).parse(d),
  )
  .handler(async ({ data }): Promise<DictLookupResult> => {
    const { db } = await import('#/db/index')
    const { lookupDictionary } = await import('#/dictionary/service')
    return lookupDictionary(db, data.lemma, data.pos)
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
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false) // save/regenerate in flight
  const [dict, setDict] = useState<DictLookupResult | null>(null)

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

  // Dictionary reference is independent of the gloss: fetch on lemma change.
  useEffect(() => {
    if (token.lemma == null) return
    let alive = true
    setDict(null)
    lookupDictFn({ data: { lemma: token.lemma, pos: token.pos ?? '' } })
      .then((r) => alive && setDict(r))
      .catch(() => {}) // reference data only; panel just omits the section
    return () => {
      alive = false
    }
  }, [token.lemma, token.pos])

  async function regenerate() {
    if (token.lemmaId == null || token.lemma == null) return
    setBusy(true)
    setError(false)
    try {
      const r = await regenerateGlossFn({
        data: {
          lemmaId: token.lemmaId,
          lemma: token.lemma,
          pos: token.pos ?? '',
          sentence,
        },
      })
      setGloss(r.italian)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  async function saveGloss() {
    if (token.lemmaId == null || !draft.trim()) return
    setBusy(true)
    try {
      const r = await saveGlossFn({
        data: { lemmaId: token.lemmaId, italian: draft },
      })
      setGloss(r.italian)
      setEditing(false)
    } finally {
      setBusy(false)
    }
  }

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
    <aside className="fixed right-0 top-0 h-full w-80 overflow-y-auto border-l border-gray-200 bg-white p-6 shadow-lg">
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 text-gray-400 hover:text-gray-700"
      >
        ✕
      </button>

      <div className="text-2xl font-bold">
        {token.surface}
        {dict?.entries[0]?.ipa && (
          <span className="ml-2 text-sm font-normal text-gray-400">
            {dict.entries[0].ipa}
          </span>
        )}
      </div>
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
            {loading || busy ? (
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
            ) : editing ? (
              <div className="flex flex-col gap-2">
                <input
                  type="text"
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveGloss()
                    if (e.key === 'Escape') setEditing(false)
                  }}
                  className="rounded border border-gray-300 px-2 py-1 text-sm"
                />
                <div className="flex gap-3 text-sm">
                  <button
                    type="button"
                    onClick={saveGloss}
                    disabled={!draft.trim()}
                    className="text-blue-600 underline disabled:opacity-50"
                  >
                    Salva
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    className="text-gray-500 underline"
                  >
                    Annulla
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <span>{gloss ?? '—'}</span>
                {token.lemmaId != null && (
                  <span className="flex gap-2 text-xs text-gray-400">
                    <button
                      type="button"
                      onClick={() => {
                        setDraft(gloss ?? '')
                        setEditing(true)
                      }}
                      className="underline hover:text-gray-700"
                    >
                      Modifica
                    </button>
                    <button
                      type="button"
                      onClick={regenerate}
                      className="underline hover:text-gray-700"
                    >
                      Rigenera
                    </button>
                  </span>
                )}
              </div>
            )}
          </dd>
        </div>
      </dl>

      {dict && dict.matchedBy !== null && <DictSection dict={dict} />}

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

const SENSE_PREVIEW = 5

// Home-dictionary reference block: senses (+ tags), inflection forms and
// etymology per entry. Multiple entries per word are legitimate (one per
// etymology section in the dump).
function DictSection({ dict }: { dict: DictLookupResult }) {
  const [showAll, setShowAll] = useState(false)
  return (
    <div className="mt-6 border-t border-gray-100 pt-4 text-sm">
      <h3 className="font-semibold text-gray-700">Dizionario</h3>
      {dict.entries.map((entry, ei) => {
        const senses = showAll ? entry.senses : entry.senses.slice(0, SENSE_PREVIEW)
        return (
          <div key={entry.id} className={ei > 0 ? 'mt-3' : 'mt-1'}>
            {/* On a pos-mismatched (lemma-only) match, label each entry. */}
            {dict.matchedBy === 'lemma' && (
              <div className="text-xs uppercase text-gray-400">{entry.pos}</div>
            )}
            <ol className="list-decimal space-y-1 pl-5">
              {senses.map((s, i) => (
                <li key={i}>
                  <span>{s.gloss}</span>
                  {s.tags.length > 0 && (
                    <span className="ml-1 text-xs text-gray-400">
                      {s.tags.join(' ')}
                    </span>
                  )}
                </li>
              ))}
            </ol>
            {entry.senses.length > SENSE_PREVIEW && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="mt-1 text-xs text-blue-600 underline"
              >
                {showAll
                  ? 'mostra meno'
                  : `mostra tutte (${entry.senses.length})`}
              </button>
            )}
            {entry.forms.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-gray-500">
                  Forme ({entry.forms.length})
                </summary>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {entry.forms.map((f, i) => (
                    <li key={i} className="flex justify-between gap-2">
                      <span className="text-gray-400">{f.tags.join(' ')}</span>
                      <span className="font-medium">{f.form}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {entry.etymology && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-gray-500">
                  Etimologia
                </summary>
                <p className="mt-1 text-xs text-gray-600">{entry.etymology}</p>
              </details>
            )}
          </div>
        )
      })}
    </div>
  )
}

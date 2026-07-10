import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useEffect, useState } from 'react'
import { z } from 'zod'

// Build a new session, or resume the held one by id (reload/refocus). No LLM
// calls: buildSession only reads cached glosses.
const startSession = createServerFn()
  .validator((d: unknown) =>
    z.object({ sessionId: z.string().nullable() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { db } = await import('#/db/index')
    const { buildSession, resumeSession } = await import('#/practice/session')
    if (data.sessionId) {
      const resumed = resumeSession(data.sessionId)
      if (resumed) return resumed
    }
    return buildSession(db, {})
  })

// Grade one answer against the server-held item (exactly once).
const submitAnswer = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    z
      .object({
        sessionId: z.string(),
        itemId: z.string(),
        choiceIndex: z.number().int().min(0),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { db } = await import('#/db/index')
    const { answerItem } = await import('#/practice/session')
    return answerItem(db, data.sessionId, data.itemId, data.choiceIndex)
  })

export const Route = createFileRoute('/practice')({
  validateSearch: (s: Record<string, unknown>): { session?: string } => ({
    session: typeof s.session === 'string' ? s.session : undefined,
  }),
  loaderDeps: ({ search }) => ({ session: search.session ?? null }),
  loader: ({ deps }) => startSession({ data: { sessionId: deps.session } }),
  component: Practice,
})

function Practice() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate()

  // Pin the session id in the URL so a reload resumes instead of rebuilding.
  useEffect(() => {
    if (search.session !== data.sessionId) {
      navigate({
        to: '/practice',
        search: { session: data.sessionId },
        replace: true,
      })
    }
  }, [data.sessionId, search.session, navigate])

  const items = data.items
  const [answered, setAnswered] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(data.answered.map((a) => [a.itemId, a.correct])),
  )
  const [reveal, setReveal] = useState<{
    itemId: string
    correctIndex: number
    picked: number
  } | null>(null)
  const [busy, setBusy] = useState(false)

  if (items.length === 0) {
    return (
      <Shell>
        <p className="text-lg">Nothing due right now. 🎉</p>
      </Shell>
    )
  }

  const total = items.length
  const answeredCount = Object.keys(answered).length
  const correctCount = Object.values(answered).filter(Boolean).length
  const index = items.findIndex((it) => !(it.id in answered))

  if (index === -1) {
    return (
      <Shell>
        <h2 className="text-xl font-bold">Session complete</h2>
        <p className="mt-2 text-gray-700">
          Reviewed {total} — {correctCount} correct.
        </p>
      </Shell>
    )
  }

  const item = items[index]

  async function choose(choiceIndex: number) {
    if (reveal || busy) return
    setBusy(true)
    try {
      const res = await submitAnswer({
        data: { sessionId: data.sessionId, itemId: item.id, choiceIndex },
      })
      setReveal({ itemId: item.id, correctIndex: res.correctIndex, picked: choiceIndex })
    } finally {
      setBusy(false)
    }
  }

  function next() {
    if (!reveal) return
    setAnswered((prev) => ({
      ...prev,
      [reveal.itemId]: reveal.correctIndex === reveal.picked,
    }))
    setReveal(null)
  }

  return (
    <Shell>
      <div className="text-sm text-gray-500">
        {answeredCount + 1} / {total}
      </div>
      <div className="mt-2 text-3xl font-bold">{item.prompt}</div>

      <div className="mt-6 space-y-2">
        {item.choices.map((choice, i) => {
          const revealed = reveal !== null
          const isCorrect = i === reveal?.correctIndex
          const isPicked = i === reveal?.picked
          const cls = !revealed
            ? 'border-gray-300 hover:bg-gray-50'
            : isCorrect
              ? 'border-green-500 bg-green-50'
              : isPicked
                ? 'border-red-500 bg-red-50'
                : 'border-gray-200 opacity-60'
          return (
            <button
              key={i}
              type="button"
              disabled={revealed}
              onClick={() => choose(i)}
              className={`block w-full rounded border px-4 py-2 text-left ${cls}`}
            >
              {choice}
            </button>
          )
        })}
      </div>

      {reveal && (
        <button
          type="button"
          onClick={next}
          className="mt-6 rounded bg-blue-600 px-4 py-2 font-medium text-white"
        >
          {index + 1 < total ? 'Next' : 'Finish'}
        </button>
      )}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-xl p-8">
      <Link to="/" className="text-sm text-blue-600 underline">
        ← Home
      </Link>
      <h1 className="mt-2 text-2xl font-bold">Practice</h1>
      <div className="mt-6">{children}</div>
    </div>
  )
}

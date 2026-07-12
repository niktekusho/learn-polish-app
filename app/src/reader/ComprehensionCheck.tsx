import { createServerFn } from '@tanstack/react-start'
import { useEffect, useState } from 'react'
import { z } from 'zod'

// Server-only: get (and lazily generate + cache) the comprehension check.
const getCheckFn = createServerFn({ method: 'POST' })
  .validator((d: unknown) => z.object({ textId: z.number().int() }).parse(d))
  .handler(async ({ data }) => {
    const { db } = await import('#/db/index')
    const { getComprehensionCheck } = await import('#/comprehension/service')
    return getComprehensionCheck(db, data.textId)
  })

// Server-only: nuke the cached questions and generate fresh.
const regenerateCheckFn = createServerFn({ method: 'POST' })
  .validator((d: unknown) => z.object({ textId: z.number().int() }).parse(d))
  .handler(async ({ data }) => {
    const { db } = await import('#/db/index')
    const { regenerateComprehensionCheck } = await import('#/comprehension/service')
    return regenerateComprehensionCheck(db, data.textId)
  })

type Question = { question: string; choices: string[]; correctIndex: number }

// End-of-text comprehension check (roadmap): Italian MCQs about the text,
// answered all-at-once, graded client-side. The answer key travels to the
// client deliberately — single-user local app, nothing persisted, so a
// server-grading round-trip buys nothing (unlike Practice, which feeds FSRS).
export function ComprehensionCheck({ textId }: { textId: number }) {
  const [questions, setQuestions] = useState<Question[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [answers, setAnswers] = useState<Record<number, number>>({})
  const [graded, setGraded] = useState(false)

  async function load(fn: typeof getCheckFn) {
    setLoading(true)
    setError(false)
    setQuestions(null)
    setAnswers({})
    setGraded(false)
    try {
      const r = await fn({ data: { textId } })
      setQuestions(r.questions)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(getCheckFn), [textId])

  const allAnswered =
    questions !== null && questions.every((_, i) => answers[i] !== undefined)
  const score =
    questions?.filter((q, i) => answers[i] === q.correctIndex).length ?? 0

  if (loading) {
    return <p className="mt-8 text-sm text-gray-400">Generazione domande…</p>
  }
  if (error || questions === null) {
    return (
      <p className="mt-8 text-sm text-red-600">
        Generazione non riuscita{' '}
        <button
          type="button"
          onClick={() => load(getCheckFn)}
          className="underline hover:text-red-700"
        >
          Riprova
        </button>
      </p>
    )
  }

  return (
    <section className="mt-8 border-t border-gray-200 pt-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Verifica comprensione</h2>
        <button
          type="button"
          onClick={() => load(regenerateCheckFn)}
          className="text-xs text-gray-400 underline hover:text-gray-700"
        >
          Rigenera domande
        </button>
      </div>

      <ol className="mt-4 space-y-6">
        {questions.map((q, qi) => (
          <li key={qi}>
            <p className="font-medium">
              {qi + 1}. {q.question}
            </p>
            <div className="mt-2 space-y-2">
              {q.choices.map((choice, ci) => {
                const picked = answers[qi] === ci
                const cls = !graded
                  ? picked
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-300 hover:bg-gray-50'
                  : ci === q.correctIndex
                    ? 'border-green-500 bg-green-50'
                    : picked
                      ? 'border-red-500 bg-red-50'
                      : 'border-gray-200 opacity-60'
                return (
                  <button
                    key={ci}
                    type="button"
                    disabled={graded}
                    onClick={() => setAnswers((prev) => ({ ...prev, [qi]: ci }))}
                    className={`block w-full rounded border px-4 py-2 text-left text-sm ${cls}`}
                  >
                    {choice}
                  </button>
                )
              })}
            </div>
          </li>
        ))}
      </ol>

      {!graded && (
        <button
          type="button"
          disabled={!allAnswered}
          onClick={() => setGraded(true)}
          className="mt-6 rounded bg-blue-600 px-4 py-2 font-medium text-white disabled:opacity-40"
        >
          Verifica
        </button>
      )}

      {graded && (
        <div className="fixed bottom-6 right-6 rounded bg-gray-900 px-4 py-2 text-white shadow-lg">
          {score} / {questions.length}
        </div>
      )}
    </section>
  )
}

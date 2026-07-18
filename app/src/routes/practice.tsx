import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { Mic, MicOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { PushToTalk } from '#/audio/recorder'

// Build a new session, or resume the held one by id (reload/refocus). No LLM
// calls: buildSession only reads cached glosses.
const startSession = createServerFn()
  .validator((d: unknown) =>
    z.object({ sessionId: z.string().nullable(), mic: z.boolean() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { db } = await import('#/db/index')
    const { buildSession, resumeSession } = await import('#/practice/session')
    if (data.sessionId) {
      const resumed = resumeSession(data.sessionId)
      if (resumed) return resumed
    }
    return buildSession(db, { mic: data.mic })
  })

// Grade one MCQ answer against the server-held item (exactly once).
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

// Speaking answer: audio blob in, ASR verdict out. FormData because the
// payload is binary; grading stays server-side (#9).
const submitSpeech = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    if (!(d instanceof FormData)) throw new Error('expected FormData')
    const audio = d.get('audio')
    if (!(audio instanceof Blob)) throw new Error('missing audio')
    return {
      sessionId: String(d.get('sessionId') ?? ''),
      itemId: String(d.get('itemId') ?? ''),
      audio,
    }
  })
  .handler(async ({ data }) => {
    const { db } = await import('#/db/index')
    const { answerSpeechItem } = await import('#/practice/session')
    return answerSpeechItem(db, data.sessionId, data.itemId, data.audio)
  })

// Give-up / no-mic path: reveal the answer without grading.
const revealSpeech = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    z.object({ sessionId: z.string(), itemId: z.string() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { revealItem } = await import('#/practice/session')
    return revealItem(data.sessionId, data.itemId)
  })

// After a reveal (ASR miss or give-up): the learner's own verdict does the
// FSRS write.
const submitSelfGrade = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    z
      .object({ sessionId: z.string(), itemId: z.string(), saidIt: z.boolean() })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { db } = await import('#/db/index')
    const { selfGradeItem } = await import('#/practice/session')
    return selfGradeItem(db, data.sessionId, data.itemId, data.saidIt)
  })

export const Route = createFileRoute('/practice')({
  validateSearch: (
    s: Record<string, unknown>,
  ): { session?: string; mic?: boolean } => ({
    session: typeof s.session === 'string' ? s.session : undefined,
    mic: typeof s.mic === 'boolean' ? s.mic : undefined,
  }),
  loaderDeps: ({ search }) => ({
    session: search.session ?? null,
    mic: search.mic ?? true,
  }),
  loader: ({ deps }) =>
    startSession({ data: { sessionId: deps.session, mic: deps.mic } }),
  component: Practice,
})

type SpeechPhase =
  | { itemId: string; phase: 'busy' }
  | { itemId: string; phase: 'correct'; transcript: string }
  | { itemId: string; phase: 'revealed'; answer: string; transcript: string }

function Practice() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate()

  // Pin the session id in the URL so a reload resumes instead of rebuilding.
  useEffect(() => {
    if (search.session !== data.sessionId) {
      navigate({
        to: '/practice',
        search: { session: data.sessionId, mic: search.mic },
        replace: true,
      })
    }
  }, [data.sessionId, search.session, search.mic, navigate])

  // key: a new session (e.g. after the mic toggle rebuilds it) must reset all
  // per-session state — answered map, reveal, speech phase.
  return <PracticeSession key={data.sessionId} />
}

function PracticeSession() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = useNavigate()
  const mic = search.mic ?? true

  const items = data.items
  const [answered, setAnswered] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(data.answered.map((a) => [a.itemId, a.correct])),
  )
  const [reveal, setReveal] = useState<{
    itemId: string
    correctIndex: number
    picked: number
  } | null>(null)
  const [speech, setSpeech] = useState<SpeechPhase | null>(null)
  const [busy, setBusy] = useState(false)

  const micToggle = (
    <button
      type="button"
      onClick={() =>
        // Toggling rebuilds the session: the mix itself changes with the mic.
        navigate({ to: '/practice', search: { mic: !mic }, replace: true })
      }
      className="flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
      title={mic ? 'Speaking exercises on' : 'Speaking exercises off'}
    >
      {mic ? <Mic size={14} /> : <MicOff size={14} />}
      {mic ? 'Mic on' : 'Mic off'}
    </button>
  )

  if (items.length === 0) {
    return (
      <Shell toolbar={micToggle}>
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
      <Shell toolbar={micToggle}>
        <h2 className="text-xl font-bold">Session complete</h2>
        <p className="mt-2 text-gray-700">
          Reviewed {total} — {correctCount} correct.
        </p>
      </Shell>
    )
  }

  const item = items[index]

  async function choose(choiceIndex: number) {
    if (reveal || busy || item.kind !== 'recognition-mcq') return
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

  async function sendAudio(blob: Blob) {
    if (speech || busy) return
    setBusy(true)
    setSpeech({ itemId: item.id, phase: 'busy' })
    try {
      const form = new FormData()
      form.set('sessionId', data.sessionId)
      form.set('itemId', item.id)
      form.set('audio', blob, 'clip')
      const res = await submitSpeech({ data: form })
      if (res.status === 'correct') {
        setSpeech({ itemId: item.id, phase: 'correct', transcript: res.transcript })
      } else if (res.status === 'miss') {
        setSpeech({
          itemId: item.id,
          phase: 'revealed',
          answer: res.answer ?? '',
          transcript: res.transcript,
        })
      } else {
        setSpeech(null) // alreadyAnswered — stale click, just move on
      }
    } catch {
      setSpeech(null) // sidecar hiccup: let the learner retry the same item
    } finally {
      setBusy(false)
    }
  }

  async function giveUp() {
    if (speech || busy) return
    setBusy(true)
    try {
      const res = await revealSpeech({
        data: { sessionId: data.sessionId, itemId: item.id },
      })
      setSpeech({ itemId: item.id, phase: 'revealed', answer: res.answer, transcript: '' })
    } finally {
      setBusy(false)
    }
  }

  async function selfGrade(saidIt: boolean) {
    setBusy(true)
    try {
      await submitSelfGrade({
        data: { sessionId: data.sessionId, itemId: item.id, saidIt },
      })
      setAnswered((prev) => ({ ...prev, [item.id]: saidIt }))
      setSpeech(null)
    } finally {
      setBusy(false)
    }
  }

  function speechNext() {
    setAnswered((prev) => ({ ...prev, [item.id]: true }))
    setSpeech(null)
  }

  return (
    <Shell toolbar={micToggle}>
      <div className="text-sm text-gray-500">
        {answeredCount + 1} / {total}
      </div>

      {item.kind === 'recognition-mcq' && (
        <>
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
        </>
      )}

      {(item.kind === 'spoken-recall' || item.kind === 'read-aloud') && (
        <>
          {item.kind === 'spoken-recall' ? (
            <>
              <div className="mt-2 text-sm text-gray-500">Say it in Polish:</div>
              <div className="mt-1 text-3xl font-bold">{item.gloss}</div>
            </>
          ) : (
            <>
              <div className="mt-2 text-sm text-gray-500">Read aloud:</div>
              <div className="mt-1 text-2xl font-medium leading-relaxed">
                {item.sentence}
              </div>
            </>
          )}

          {(!speech || speech.itemId !== item.id) && (
            <div className="mt-6 flex flex-col items-start gap-3">
              <PushToTalk onRecorded={sendAudio} disabled={busy} />
              <button
                type="button"
                onClick={giveUp}
                disabled={busy}
                className="text-sm text-gray-500 underline"
              >
                Show answer
              </button>
            </div>
          )}

          {speech?.phase === 'busy' && (
            <p className="mt-6 text-gray-500">Transcribing…</p>
          )}

          {speech?.phase === 'correct' && (
            <div className="mt-6">
              <div className="rounded border border-green-500 bg-green-50 px-4 py-3">
                ✓ Correct — heard “{speech.transcript}”
              </div>
              <button
                type="button"
                onClick={speechNext}
                className="mt-4 rounded bg-blue-600 px-4 py-2 font-medium text-white"
              >
                {index + 1 < total ? 'Next' : 'Finish'}
              </button>
            </div>
          )}

          {speech?.phase === 'revealed' && (
            <div className="mt-6">
              <div className="rounded border border-gray-300 bg-gray-50 px-4 py-3">
                <div className="text-2xl font-bold">{speech.answer}</div>
                {speech.transcript ? (
                  <div className="mt-1 text-sm text-gray-500">
                    Heard: “{speech.transcript}”
                  </div>
                ) : null}
              </div>
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => selfGrade(true)}
                  className="rounded bg-green-600 px-4 py-2 font-medium text-white"
                >
                  I said it
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => selfGrade(false)}
                  className="rounded bg-red-600 px-4 py-2 font-medium text-white"
                >
                  I didn’t
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </Shell>
  )
}

function Shell({
  children,
  toolbar,
}: {
  children: React.ReactNode
  toolbar?: React.ReactNode
}) {
  return (
    <div className="mx-auto max-w-xl p-8">
      <div className="flex items-center justify-between">
        <Link to="/" className="text-sm text-blue-600 underline">
          ← Home
        </Link>
        {toolbar}
      </div>
      <h1 className="mt-2 text-2xl font-bold">Practice</h1>
      <div className="mt-6">{children}</div>
    </div>
  )
}

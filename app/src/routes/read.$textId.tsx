import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useMemo, useState } from 'react'
import { z } from 'zod'
import { WordPanel } from '#/reader/WordPanel'
import type { KnowledgeFlags, ReaderToken } from '#/reader/types'

// Load a text and its tokens in reading order. `known` / `stillLearning` are
// computed server-side; the client never sees the raw FSRS state.
const getText = createServerFn()
  .validator((textId: unknown) => z.coerce.number().int().parse(textId))
  .handler(async ({ data: textId }) => {
    const { db, schema } = await import('#/db/index')
    const { and, asc, eq } = await import('drizzle-orm')
    const { knowledgeFlags } = await import('#/reader/knowledge')

    const [text] = db
      .select()
      .from(schema.sourceText)
      .where(eq(schema.sourceText.id, textId))
      .all()
    if (!text) throw notFound()

    const rows = db
      .select({
        surface: schema.token.surface,
        isSpace: schema.token.isSpace,
        position: schema.token.position,
        sentenceIndex: schema.token.sentenceIndex,
        lemmaId: schema.lemma.id,
        lemma: schema.lemma.lemma,
        pos: schema.lemma.pos,
        receptiveState: schema.knowledge.state,
      })
      .from(schema.token)
      .leftJoin(schema.lemma, eq(schema.token.lemmaId, schema.lemma.id))
      .leftJoin(
        schema.knowledge,
        and(
          eq(schema.knowledge.lemmaId, schema.token.lemmaId),
          eq(schema.knowledge.track, 'receptive'),
        ),
      )
      .where(eq(schema.token.textId, textId))
      .orderBy(asc(schema.token.position))
      .all()

    const tokens: ReaderToken[] = rows.map(({ receptiveState, ...t }) => ({
      ...t,
      ...knowledgeFlags(receptiveState),
    }))
    return { text, tokens }
  })

// Batch-mark every still-New word in a text as known (grade Easy) in ONE
// transaction. Excludes words the user explicitly marked "still learning"
// (Learning/Relearning) — the batch must not overwrite an explicit judgment.
const batchMarkKnown = createServerFn({ method: 'POST' })
  .validator((d: unknown) => z.object({ textId: z.number().int() }).parse(d))
  .handler(async ({ data }): Promise<{ lemmaIds: number[] }> => {
    const { db } = await import('#/db/index')
    const { markNewKnown } = await import('#/reader/mark')
    return { lemmaIds: markNewKnown(db, data.textId) }
  })

export const Route = createFileRoute('/read/$textId')({
  component: Reader,
  loader: ({ params }) => getText({ data: params.textId }),
})

function Reader() {
  const { text, tokens } = Route.useLoaderData()
  const [selected, setSelected] = useState<ReaderToken | null>(null)
  // Live verdict overrides so marking updates highlights without a reload.
  const [overrides, setOverrides] = useState<Record<number, KnowledgeFlags>>({})

  const flagsOf = (t: ReaderToken): KnowledgeFlags =>
    t.lemmaId != null && overrides[t.lemmaId]
      ? overrides[t.lemmaId]
      : { known: t.known, stillLearning: t.stillLearning }
  const isUnknown = (t: ReaderToken) => t.lemmaId != null && !flagsOf(t).known

  // Batch only burns never-touched (New) words: unknown and not still-learning.
  const batchEligible = useMemo(() => {
    const ids = new Set<number>()
    for (const t of tokens) {
      if (t.lemmaId == null) continue
      const f = flagsOf(t)
      if (!f.known && !f.stillLearning) ids.add(t.lemmaId)
    }
    return ids
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens, overrides])

  function markGraded(lemmaId: number, flags: KnowledgeFlags) {
    setOverrides((prev) => ({ ...prev, [lemmaId]: flags }))
  }

  async function markAllNewKnown() {
    if (batchEligible.size === 0) return
    const { lemmaIds } = await batchMarkKnown({ data: { textId: text.id } })
    setOverrides((prev) => {
      const next = { ...prev }
      for (const id of lemmaIds) next[id] = { known: true, stillLearning: false }
      return next
    })
  }

  return (
    <div className="mx-auto max-w-3xl p-8">
      <Link to="/" className="text-sm text-blue-600 underline">
        ← All texts
      </Link>
      <div className="mt-2 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{text.title || `Text #${text.id}`}</h1>
        <button
          type="button"
          onClick={markAllNewKnown}
          disabled={batchEligible.size === 0}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          Mark {batchEligible.size} new word{batchEligible.size === 1 ? '' : 's'}{' '}
          known
        </button>
      </div>

      <article className="mt-6 whitespace-pre-wrap text-lg leading-relaxed">
        {tokens.map((t, i) => {
          if (t.isSpace || t.lemmaId == null) {
            return <span key={i}>{t.surface}</span>
          }
          const f = flagsOf(t)
          const cls = !isUnknown(t)
            ? 'hover:bg-gray-200'
            : f.stillLearning
              ? 'bg-orange-200 hover:bg-orange-300' // explicit "still learning"
              : 'bg-yellow-200 hover:bg-yellow-300' // never-touched unknown
          return (
            <span
              key={i}
              onClick={() => setSelected(t)}
              className={`cursor-pointer rounded ${cls}`}
            >
              {t.surface}
            </span>
          )
        })}
      </article>

      {selected && (
        <WordPanel
          token={selected}
          sentence={tokens
            .filter((t) => t.sentenceIndex === selected.sentenceIndex)
            .map((t) => t.surface)
            .join('')}
          onGraded={markGraded}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}

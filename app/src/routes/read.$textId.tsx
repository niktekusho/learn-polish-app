import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { z } from 'zod'
import { WordPanel } from '#/reader/WordPanel'
import type { ReaderToken } from '#/reader/types'

// Load a text and its tokens in reading order. `known` is computed server-side
// via the single receptive-known rule; the client never sees the raw state.
const getText = createServerFn()
  .validator((textId: unknown) => z.coerce.number().int().parse(textId))
  .handler(async ({ data: textId }) => {
    const { db, schema } = await import('#/db/index')
    const { and, asc, eq } = await import('drizzle-orm')
    const { isReceptiveKnown } = await import('#/reader/knowledge')

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
      known: isReceptiveKnown(receptiveState),
    }))
    return { text, tokens }
  })

export const Route = createFileRoute('/read/$textId')({
  component: Reader,
  loader: ({ params }) => getText({ data: params.textId }),
})

function Reader() {
  const { text, tokens } = Route.useLoaderData()
  const [selected, setSelected] = useState<ReaderToken | null>(null)

  const isUnknown = (t: ReaderToken) => t.lemmaId != null && !t.known

  return (
    <div className="mx-auto max-w-3xl p-8">
      <Link to="/" className="text-sm text-blue-600 underline">
        ← All texts
      </Link>
      <h1 className="mt-2 text-2xl font-bold">
        {text.title || `Text #${text.id}`}
      </h1>

      <article className="mt-6 whitespace-pre-wrap text-lg leading-relaxed">
        {tokens.map((t, i) => {
          if (t.isSpace || t.lemmaId == null) {
            return <span key={i}>{t.surface}</span>
          }
          return (
            <span
              key={i}
              onClick={() => setSelected(t)}
              className={
                'cursor-pointer rounded ' +
                (isUnknown(t)
                  ? 'bg-yellow-200 hover:bg-yellow-300'
                  : 'hover:bg-gray-200')
              }
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
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}

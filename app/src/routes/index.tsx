import { Link, createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'

// List imported texts, newest first, with their token counts.
const listTexts = createServerFn().handler(async () => {
  const { db, schema } = await import('#/db/index')
  const { count, desc, eq } = await import('drizzle-orm')
  return db
    .select({
      id: schema.sourceText.id,
      title: schema.sourceText.title,
      createdAt: schema.sourceText.createdAt,
      tokens: count(schema.token.id),
    })
    .from(schema.sourceText)
    .leftJoin(schema.token, eq(schema.token.textId, schema.sourceText.id))
    .groupBy(schema.sourceText.id)
    .orderBy(desc(schema.sourceText.createdAt))
    .all()
})

export const Route = createFileRoute('/')({
  component: Home,
  loader: () => listTexts(),
})

function Home() {
  const texts = Route.useLoaderData()
  return (
    <div className="mx-auto max-w-2xl p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Learn Polish</h1>
        <div className="flex gap-2">
          <Link
            to="/maintenance"
            className="rounded border border-gray-300 px-4 py-2 font-medium"
          >
            Maintenance
          </Link>
          <Link
            to="/practice"
            className="rounded border border-gray-300 px-4 py-2 font-medium"
          >
            Practice
          </Link>
          <Link
            to="/import"
            className="rounded bg-blue-600 px-4 py-2 font-medium text-white"
          >
            Import text
          </Link>
        </div>
      </div>

      {texts.length === 0 ? (
        <p className="mt-8 text-gray-600">
          No texts yet.{' '}
          <Link to="/import" className="text-blue-600 underline">
            Import one
          </Link>{' '}
          to start reading.
        </p>
      ) : (
        <ul className="mt-8 divide-y divide-gray-200">
          {texts.map((t) => (
            <li key={t.id}>
              <Link
                to="/read/$textId"
                params={{ textId: String(t.id) }}
                className="flex items-center justify-between py-3 hover:bg-gray-50"
              >
                <span className="font-medium">{t.title || `Text #${t.id}`}</span>
                <span className="text-sm text-gray-500">{t.tokens} tokens</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

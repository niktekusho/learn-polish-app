import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { count } from 'drizzle-orm'

// Server-only: proves the migrated SQLite DB round-trips (insert + read a row).
const dbPing = createServerFn().handler(async () => {
  const { db, schema } = await import('#/db/index')
  await db.insert(schema.scaffoldCheck).values({ note: 'scaffold ping' })
  const [{ rows }] = await db
    .select({ rows: count() })
    .from(schema.scaffoldCheck)
  return { rows }
})

export const Route = createFileRoute('/')({
  component: Home,
  loader: () => dbPing(),
})

function Home() {
  const { rows } = Route.useLoaderData()
  return (
    <div className="p-8">
      <h1 className="text-4xl font-bold">Learn Polish</h1>
      <p className="mt-4 text-lg">Repo scaffold is live.</p>
      <p className="mt-2 text-sm text-gray-600">
        SQLite round-trip OK — <code>scaffold_check</code> now holds {rows}{' '}
        row(s).
      </p>
    </div>
  )
}

import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

// List imported texts, newest first, with their token counts.
const listTexts = createServerFn().handler(async () => {
  const { db, schema } = await import("#/db/index");
  const { count, desc, eq } = await import("drizzle-orm");
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
    .all();
});

const getToday = createServerFn().handler(async () => {
  const { db } = await import("#/db/index");
  const { getRecap } = await import("#/recap/service");
  return getRecap(db);
});

export const Route = createFileRoute("/")({
  component: Home,
  loader: async () => {
    const [texts, today] = await Promise.all([listTexts(), getToday()]);
    return { texts, today };
  },
});

function Home() {
  const { texts, today } = Route.useLoaderData();
  return (
    <div className="mx-auto max-w-2xl p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold">Learn Polish</h1>
        <div className="flex flex-wrap gap-2">
          <Link to="/maintenance" className="rounded border border-gray-300 px-4 py-2 font-medium">
            Maintenance
          </Link>
          <Link to="/import" className="rounded border border-gray-300 px-4 py-2 font-medium">
            Import text
          </Link>
          <Link to="/story" className="rounded border border-gray-300 px-4 py-2 font-medium">
            Leggi
          </Link>
          <Link
            to="/practice"
            className="rounded bg-blue-600 border border-gray-300 px-4 py-2 font-medium text-white"
          >
            Practice
          </Link>
        </div>
      </div>

      <section className="mt-6 rounded border border-gray-200 p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Oggi</h2>
          <span className="text-sm text-gray-600">
            🔥 {today.streak} {today.streak === 1 ? "giorno" : "giorni"} di fila
          </span>
        </div>
        <ul className="mt-2 space-y-1">
          <li>
            {today.practiceDone ? "✅" : "⬜"}{" "}
            <Link to="/practice" className="underline">
              Pratica
            </Link>
          </li>
          <li>{today.episodeDone ? "✅" : "⬜"} Episodio</li>
        </ul>
        {today.complete && (
          <Link to="/recap" className="mt-3 inline-block text-sm text-blue-600 underline">
            Giornata completa: vedi il riepilogo →
          </Link>
        )}
      </section>

      {texts.length === 0 ? (
        <p className="mt-8 text-gray-600">
          No texts yet.{" "}
          <Link to="/import" className="text-blue-600 underline">
            Import one
          </Link>{" "}
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
  );
}

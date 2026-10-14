import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

const getRecapFn = createServerFn().handler(async () => {
  const { db } = await import("#/db/index");
  const { getRecap } = await import("#/recap/service");
  return getRecap(db);
});

export const Route = createFileRoute("/recap")({
  component: RecapPage,
  loader: () => getRecapFn(),
});

function RecapPage() {
  const r = Route.useLoaderData();
  return (
    <div className="mx-auto max-w-xl p-8">
      <Link to="/" className="text-sm text-blue-600 underline">
        ← Home
      </Link>
      <h1 className="mt-2 text-2xl font-bold">
        {r.complete ? "Giornata completa! 🎉" : "Riepilogo di oggi"}
      </h1>
      <ul className="mt-6 space-y-4 text-lg">
        <li>
          <span className="font-bold">{r.newWords}</span>{" "}
          {r.newWords === 1 ? "parola nuova" : "parole nuove"}
        </li>
        <li>
          <span className="font-bold">{r.stronger.count}</span>{" "}
          {r.stronger.count === 1 ? "parola più solida" : "parole più solide"}
          {r.stronger.examples.length > 0 && (
            <span className="text-gray-600"> — {r.stronger.examples.join(", ")}</span>
          )}
        </li>
        <li>
          <span className="font-bold">{r.matured.count}</span>{" "}
          {r.matured.count === 1 ? "parola consolidata" : "parole consolidate"}
          {r.matured.examples.length > 0 && (
            <span className="text-gray-600"> — {r.matured.examples.join(", ")}</span>
          )}
        </li>
        <li>
          🔥 <span className="font-bold">{r.streak}</span> {r.streak === 1 ? "giorno" : "giorni"} di
          fila
        </li>
      </ul>
    </div>
  );
}

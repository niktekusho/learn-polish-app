import { Link, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { z } from "zod";
import type { StoryPremise } from "#/llm/provider";

// The active story and its unread episode. A missing episode (background
// generation failed) is generated here: the only wait outside story start.
const getStoryState = createServerFn().handler(async () => {
  const { appStoryService } = await import("#/story/server");
  const svc = appStoryService();
  const current = await svc.currentEpisode();
  return { story: svc.activeStory(), current };
});

const getPremises = createServerFn({ method: "POST" }).handler(async () => {
  const { appStoryService } = await import("#/story/server");
  return appStoryService().proposePremises();
});

const premiseInput = z.object({ title: z.string(), genre: z.string(), hook: z.string() });

const startStoryFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => premiseInput.parse(d))
  .handler(async ({ data }) => {
    const { appStoryService } = await import("#/story/server");
    return appStoryService().startStory(data);
  });

const abandonStoryFn = createServerFn({ method: "POST" }).handler(async () => {
  const { appStoryService } = await import("#/story/server");
  appStoryService().abandonStory();
});

export const Route = createFileRoute("/story")({
  component: StoryPage,
  loader: () => getStoryState(),
  pendingComponent: () => <Shell>Preparo l'episodio…</Shell>,
});

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-xl p-8">
      <Link to="/" className="text-sm text-blue-600 underline">
        ← Home
      </Link>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function StoryPage() {
  const { story, current } = Route.useLoaderData();
  const router = useRouter();
  if (!story) return <PremisePicker />;

  async function abandon() {
    if (!window.confirm("Abbandonare questa storia? Gli episodi restano tra i testi.")) return;
    await abandonStoryFn();
    router.invalidate();
  }

  return (
    <Shell>
      <h1 className="text-2xl font-bold">{story.title}</h1>
      <p className="text-sm text-gray-600">
        {story.genre} · {story.hook}
      </p>
      {current && (
        <Link
          to="/read/$textId"
          params={{ textId: String(current.textId) }}
          className="mt-6 block rounded bg-blue-600 px-4 py-3 text-center font-medium text-white"
        >
          Leggi l'episodio {current.episodeNumber} di {current.totalEpisodes}
        </Link>
      )}
      <ul className="mt-6 divide-y divide-gray-200">
        {story.episodes
          .filter((e) => e.read)
          .map((e) => (
            <li key={e.textId}>
              <Link
                to="/read/$textId"
                params={{ textId: String(e.textId) }}
                className="block py-2 hover:bg-gray-50"
              >
                Episodio {e.episodeNumber} ✓
              </Link>
            </li>
          ))}
      </ul>
      <button
        type="button"
        onClick={abandon}
        className="mt-8 text-sm text-gray-500 underline hover:text-red-600"
      >
        Nuova storia
      </button>
    </Shell>
  );
}

function PremisePicker() {
  const navigate = useNavigate();
  const [premises, setPremises] = useState<StoryPremise[] | null>(null);
  const [error, setError] = useState(false);
  const [starting, setStarting] = useState<StoryPremise | null>(null);

  async function reroll() {
    setPremises(null);
    setError(false);
    try {
      setPremises(await getPremises());
    } catch {
      setError(true);
    }
  }

  useEffect(() => void reroll(), []);

  async function start(p: StoryPremise) {
    setStarting(p);
    try {
      const ep = await startStoryFn({ data: p });
      if (ep) navigate({ to: "/read/$textId", params: { textId: String(ep.textId) } });
      else navigate({ to: "/story" });
    } catch {
      setStarting(null);
      setError(true);
    }
  }

  if (starting) {
    return <Shell>Scrivo il primo episodio di «{starting.title}»…</Shell>;
  }

  return (
    <Shell>
      <h1 className="text-2xl font-bold">Scegli una storia</h1>
      {error && <p className="mt-4 text-sm text-red-600">Qualcosa è andato storto. Riprova.</p>}
      {!premises && !error && <p className="mt-6 text-gray-500">Cerco idee…</p>}
      <div className="mt-6 space-y-3">
        {premises?.map((p, i) => (
          <button
            key={i}
            type="button"
            onClick={() => start(p)}
            className="block w-full rounded border border-gray-300 px-4 py-3 text-left font-serif hover:bg-gray-50"
          >
            <div className="font-semibold">{p.title}</div>
            <div className="text-xs uppercase text-gray-500">{p.genre}</div>
            <div className="mt-1 text-sm text-gray-700">{p.hook}</div>
          </button>
        ))}
      </div>
      <button type="button" onClick={reroll} className="mt-4 text-sm text-blue-600 underline">
        Altre idee
      </button>
    </Shell>
  );
}

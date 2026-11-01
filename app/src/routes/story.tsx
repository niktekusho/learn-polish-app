import { Link, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CircleAlert,
  Flag,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { StoryPremise } from "#/llm/provider";
import { plural } from "#/plural";
import {
  BTN_DANGER,
  BTN_PRIMARY,
  BTN_QUIET,
  ERROR_LINE,
  ICON_BUTTON,
  LABEL_TYPE,
  Tick,
} from "#/ui";

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
  pendingComponent: () => <Wait>Preparo l'episodio…</Wait>,
});

type Story = NonNullable<ReturnType<typeof Route.useLoaderData>["story"]>;

const PAGE = "flex h-dvh flex-col bg-paper font-sans text-base text-ink";
const SECTION_HEAD = `${LABEL_TYPE} text-ink-2`;
const REVEAL = "animate-rise motion-reduce:animate-none [animation-delay:calc(var(--i)*70ms)]";
const order = (i: number) => ({ "--i": i }) as React.CSSProperties;
const COVER_GROUND =
  "bg-[radial-gradient(520px_420px_at_110%_-10%,var(--color-accent-soft)_0%,transparent_70%),var(--color-paper)]";

function TopBar() {
  return (
    <header className="flex shrink-0 items-center px-1 py-1.5">
      <Link to="/" aria-label="Home" className={ICON_BUTTON}>
        <ArrowLeft size={20} />
      </Link>
    </header>
  );
}

function Wait({ card, children }: { card?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={`${PAGE} items-center justify-center gap-4 p-6 text-center`}>
      {card}
      <div className="flex gap-2" aria-hidden>
        {[0, 150, 300].map((d) => (
          <i
            key={d}
            className="size-2.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none"
            style={{ animationDelay: `${d}ms` }}
          />
        ))}
      </div>
      <p role="status" className="max-w-[26ch] font-serif text-prose leading-normal text-ink-2">
        {children}
      </p>
    </div>
  );
}

function readOn(at: Date) {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const ago = Math.round((day(new Date()) - day(at)) / 86_400_000);
  if (ago === 0) return "letto oggi";
  if (ago === 1) return "letto ieri";
  return `letto ${at.toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" })}`;
}

function StoryPage() {
  const { story, current } = Route.useLoaderData();
  if (!story) return <PremisePicker />;

  const read = story.episodes.filter((e) => e.readAt);
  const readButton = (wide: boolean) =>
    current && (
      <Link
        to="/read/$textId"
        params={{ textId: String(current.textId) }}
        className={`${BTN_PRIMARY} ${wide ? "w-full" : ""}`}
      >
        <BookOpen size={18} />
        Leggi l'episodio {current.episodeNumber}
      </Link>
    );

  return (
    <div className={`${PAGE} ${COVER_GROUND}`}>
      <TopBar />
      <main className="min-h-0 flex-1 overflow-auto sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] sm:overflow-hidden">
        <Cover story={story} read={read.length} action={readButton(false)} />
        <section
          className={`border-t border-rule bg-paper/70 px-4 pt-5 pb-7 sm:overflow-auto sm:border-t-0 sm:border-l sm:bg-paper sm:px-6 sm:py-3 lg:px-12 lg:py-8 ${REVEAL}`}
          style={order(4)}
        >
          {read.length > 0 && (
            <>
              <h2 className={`mb-3 ml-1 ${SECTION_HEAD}`}>Episodi precedenti</h2>
              <ol className="grid pl-1">
                {[...read].reverse().map((e) => (
                  <PastEpisode key={e.textId} episode={e} />
                ))}
              </ol>
            </>
          )}
          <Abandon />
        </section>
      </main>
      {/* Narrow: the action docks at the bottom, in thumb reach. */}
      {current && (
        <div className="grid shrink-0 border-t border-rule bg-paper/85 px-4 pt-3 pb-[max(20px,env(safe-area-inset-bottom))] sm:hidden">
          {readButton(true)}
        </div>
      )}
    </div>
  );
}

function Cover({ story, read, action }: { story: Story; read: number; action: React.ReactNode }) {
  return (
    <div className="grid content-center gap-3 px-6 pt-2 pb-6 sm:overflow-auto sm:[align-content:safe_center] sm:px-8 lg:px-16">
      <span
        className={`flex items-center gap-2 text-accent-ink before:h-0.5 before:w-6 before:bg-current ${LABEL_TYPE} tracking-[0.1em] ${REVEAL}`}
        style={order(0)}
      >
        {story.genre}
      </span>
      <h1
        className={`font-serif text-[34px] leading-[1.08] font-bold tracking-[-0.02em] text-balance lg:text-[52px] ${REVEAL}`}
        style={order(1)}
      >
        {story.title}
      </h1>
      <p
        className={`font-serif text-md leading-normal text-ink-2 italic ${REVEAL}`}
        style={order(2)}
      >
        {story.hook}
      </p>
      <div className={`mt-2 grid gap-2 ${REVEAL}`} style={order(3)}>
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: `repeat(${story.totalEpisodes}, minmax(0, 1fr))` }}
          aria-hidden
        >
          {Array.from({ length: story.totalEpisodes }, (_, i) => (
            <i
              key={i}
              className={`h-1.5 rounded-full ${
                i < read
                  ? "bg-accent"
                  : i === read
                    ? "bg-[repeating-linear-gradient(90deg,var(--color-accent)_0_4px,transparent_4px_7px)] opacity-70"
                    : "bg-rule"
              }`}
            />
          ))}
        </div>
        <span className="text-sm text-ink-3 tabular-nums">
          {read} di {story.totalEpisodes} episodi letti
        </span>
      </div>
      <div className="mt-2 hidden sm:flex">{action}</div>
    </div>
  );
}

function PastEpisode({ episode: e }: { episode: Story["episodes"][number] }) {
  return (
    <li className="relative grid grid-cols-[32px_minmax(0,1fr)] gap-x-3 pb-4 before:absolute before:top-[34px] before:bottom-0 before:left-[15px] before:w-0.5 before:bg-rule last:before:hidden">
      <Tick />
      <div className="grid min-w-0 gap-1">
        <div className="flex min-h-8 items-center justify-between gap-2">
          <b className="font-semibold">Episodio {e.episodeNumber}</b>
          {e.readAt && (
            // "oggi" and "ieri" depend on the clock, which can differ between server and phone.
            <span suppressHydrationWarning className="text-sm text-ink-3">
              {readOn(new Date(e.readAt))}
            </span>
          )}
        </div>
        <span className="-mt-1 text-sm text-ink-3 tabular-nums">
          {e.words} {plural(e.words, "parola", "parole")} · {e.newWords}{" "}
          {plural(e.newWords, "nuova", "nuove")}
        </span>
        {e.summary && (
          <p className="font-serif text-[16px] leading-[1.55] text-ink-2">{e.summary}</p>
        )}
        <Link
          to="/read/$textId"
          params={{ textId: String(e.textId) }}
          className="-my-2 inline-flex min-h-11 items-center gap-1 justify-self-start text-sm font-semibold text-accent-ink"
        >
          <RotateCcw size={16} />
          Rileggi
        </Link>
      </div>
    </li>
  );
}

/** Ending the story asks first, in a sheet on the phone and a dialog on wide screens. */
function Abandon() {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);

  async function abandon() {
    setBusy(true);
    try {
      await abandonStoryFn();
      dialog.current?.close();
      await router.invalidate();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex justify-center sm:justify-start">
        <button
          type="button"
          onClick={() => dialog.current?.showModal()}
          className="inline-flex min-h-11 items-center gap-2 font-semibold text-bad-ink"
        >
          <Flag size={18} />
          Abbandona la storia
        </button>
      </div>
      <dialog
        ref={dialog}
        aria-labelledby="abandon-title"
        className="mx-auto mt-auto mb-0 w-full max-w-none animate-sheet-in rounded-t-lg bg-panel p-0 font-sans text-ink shadow-sheet backdrop:bg-ink/40 motion-reduce:animate-none sm:my-auto sm:max-w-[440px] sm:animate-none sm:rounded-lg"
        // The content div fills the dialog, so a click landing on the dialog itself is on the backdrop.
        onClick={(e) => e.target === dialog.current && dialog.current.close()}
      >
        <div className="px-5 pt-5 pb-[max(20px,env(safe-area-inset-bottom))] sm:p-6">
          <h2 id="abandon-title" className="font-serif text-lg font-bold">
            Abbandonare la storia?
          </h2>
          <p className="mt-2 font-serif text-[16px] text-ink-2">Gli episodi restano tra i testi.</p>
          <div className="mt-4 grid gap-2 sm:flex sm:justify-end">
            <button type="button" onClick={() => dialog.current?.close()} className={BTN_QUIET}>
              Annulla
            </button>
            <button type="button" onClick={abandon} disabled={busy} className={BTN_DANGER}>
              Abbandona
            </button>
          </div>
        </div>
      </dialog>
    </>
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
    return (
      <Wait
        card={
          <div className="grid max-w-[380px] gap-2 rounded-lg bg-card p-5 text-left shadow-card">
            <Premise premise={starting} />
          </div>
        }
      >
        Scrivo il primo episodio di «{starting.title}»…
      </Wait>
    );
  }

  return (
    <div className={PAGE}>
      <TopBar />
      <main className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto grid max-w-[1080px] gap-4 px-4 pt-1 pb-7 sm:px-6 sm:pb-6 lg:gap-7 lg:pt-6">
          <div className="grid gap-2 px-1">
            <h1 className="font-serif text-2xl font-bold sm:text-xl lg:text-[32px]">
              Scegli una storia
            </h1>
            <p className="font-serif text-[16px] text-ink-2">
              Tre idee. Scrivo il primo episodio appena ne scegli una.
            </p>
          </div>
          {error && (
            <p role="alert" className={`rounded bg-bad-soft px-3 py-3 ${ERROR_LINE}`}>
              <CircleAlert size={18} />
              Qualcosa è andato storto. Riprova.
            </p>
          )}
          {!premises && !error && (
            <div className="grid gap-4 sm:grid-cols-3" role="status" aria-label="Cerco idee…">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-[150px] animate-pulse rounded-lg bg-card motion-reduce:animate-none"
                />
              ))}
            </div>
          )}
          {premises && (
            <div className="grid gap-4 sm:grid-cols-3">
              {premises.map((p, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => start(p)}
                  className={`grid content-start gap-2 rounded-lg bg-card p-4 pb-5 text-left shadow-card ${REVEAL}`}
                  style={order(i)}
                >
                  <Premise premise={p} />
                  <span className="mt-1 inline-flex items-center gap-2 font-semibold text-accent-ink">
                    Inizia <ArrowRight size={18} />
                  </span>
                </button>
              ))}
            </div>
          )}
          <button type="button" onClick={reroll} className={`${BTN_QUIET} justify-self-center`}>
            <RefreshCw size={18} />
            Altre idee
          </button>
        </div>
      </main>
    </div>
  );
}

function Premise({ premise: p }: { premise: StoryPremise }) {
  return (
    <>
      <span
        className={`justify-self-start rounded-full bg-accent-soft px-3 py-1 text-accent-ink ${LABEL_TYPE}`}
      >
        {p.genre}
      </span>
      <b className="font-serif text-lg font-semibold">{p.title}</b>
      <span className="font-serif text-[16px] leading-normal text-ink-2">{p.hook}</span>
    </>
  );
}
